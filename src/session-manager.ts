import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { unlink } from "node:fs/promises"
import { log } from "./logger.js"
import type { ProxyMcpServer } from "./proxy-mcp.js"
import { clearLedger } from "./todo-ledger.js"
import {
  cliSupportsThinking,
  cliSupportsThinkingDisplay,
  type CliVersion,
} from "./cli-version.js"

export interface ActiveProcess {
  proc: ChildProcess
  lineEmitter: EventEmitter
  proxyServer?: ProxyMcpServer | null
  /**
   * Hash of the bridged opencode MCP config the process was spawned with.
   * `null` when the bridge produced nothing (no MCP servers). `undefined`
   * when the bridge was disabled. Used to detect mid-session config drift
   * and force a respawn.
   */
  mcpHash?: string | null
  /** Temp file holding `--append-system-prompt-file` content; unlinked on exit. */
  systemPromptFile?: string
  /**
   * True for the Bun-PTY interactive transport, whose `stdin.write` types
   * into a TUI rather than speaking stream-json. Interrupting one means
   * sending a keystroke, not a control request — see `interruptTurn`.
   */
  interactive?: boolean
  /**
   * Epoch ms of the last turn that needed this process. Stamped on spawn and
   * refreshed by `touch()`, so it tracks "last time a chat used this CLI",
   * not "last byte on the wire". Drives `reapIdleProcesses`.
   */
  lastUsedAt?: number
}

// One active CLI process per session key. Keyed by a composite
// (cwd + model + opencode session-affinity) so two chats don't race.
// Iteration order is insertion order, which we refresh on access to
// make this a poor-man's LRU; see `touch()` below.
const activeProcesses = new Map<string, ActiveProcess>()
const claudeSessions = new Map<string, string>()

// Cap on live CLI subprocesses. Session-affinity-keyed entries accumulate
// one-per-chat, so an unbounded map would leak processes as users open new
// chats. This caps at a reasonable working-set and evicts the oldest.
//
// Keep this modest: an idle `claude --print` holds ~250 MB resident, so the
// old cap of 16 let a single opencode instance sit on ~4 GB of chats nobody
// had touched in a day. The idle reaper below is what does the real work;
// this is only the backstop for a burst of chats inside one TTL window.
const MAX_ACTIVE_PROCESSES = 8

// LRU pressure alone never reaps: a user who opens 8 chats and walks away
// keeps 8 CLI processes alive indefinitely. Idle processes are cheap to drop
// because the Claude session id lives in `claudeSessions`, not on the
// process — the next turn respawns with `--resume` and full continuity.
const IDLE_PROCESS_TTL_MS = 30 * 60_000
const IDLE_SWEEP_INTERVAL_MS = 5 * 60_000
const PROCESS_EXIT_TIMEOUT_MS = 1_500
const PROCESS_FORCE_EXIT_TIMEOUT_MS = 500
// An interrupted turn reports back in milliseconds. This bound only matters
// when the CLI is wedged, and we proceed anyway once it lapses.
export const TURN_INTERRUPT_TIMEOUT_MS = 5_000

function envFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  if (!normalized) return false
  return !["0", "false", "no", "off"].includes(normalized)
}

export function isClaudeThinkingDisabled(): boolean {
  return (
    envFlagEnabled(process.env.CLAUDE_CODE_DISABLE_THINKING) ||
    envFlagEnabled(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING)
  )
}

export function claudeSpawnEnv(opts?: {
  ignoreAnthropicApiKey?: boolean
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    TERM: "xterm-256color",
  }

  // Force subscription auth: with an API key in the env, Claude Code bills
  // pay-as-you-go (Console) instead of the logged-in plan, bypassing the
  // Agent SDK credit. Opt-in via `ignoreAnthropicApiKey`.
  if (opts?.ignoreAnthropicApiKey) {
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
  }

  // Default-on thinking summaries for opus-4-7 (which omits thinking by
  // default on the CLI side). Any var the user has explicitly set in their
  // shell is passed through untouched; the plugin only fills in the default.
  if (
    !isClaudeThinkingDisabled() &&
    process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES === undefined
  ) {
    env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES = "1"
  }

  return env
}

// ---------------------------------------------------------------------------
// Turn lifecycle
//
// The Claude CLI runs exactly one turn at a time. Writing a user message while
// a turn is still in flight does NOT start a new turn: the CLI queues the
// message, keeps streaming the old turn's output onto the same stdout, and
// emits the OLD turn's `result` first. Whoever is listening then attributes
// the old turn's tail to the new turn and closes on the wrong `result` — the
// new message's real answer arrives after the stream is gone.
//
// That is exactly what an abort used to leave behind, because closing our end
// of the stream never told the CLI anything. So: every stdin write that starts
// work announces itself via `noteTurnStarted`, a permanent line listener marks
// the process idle again on the CLI's terminal `result`, and `interruptTurn`
// makes an abort actually abort.

interface TurnTracker {
  inFlight: boolean
  waiters: Array<() => void>
}

const turnTrackers = new WeakMap<ActiveProcess, TurnTracker>()

/** Cheap pre-filter before JSON.parse — every CLI stdout line hits this. */
function isTerminalResultLine(line: string): boolean {
  if (!line.includes('"result"')) return false
  try {
    return (JSON.parse(line) as { type?: string }).type === "result"
  } catch {
    return false
  }
}

function turnTracker(ap: ActiveProcess): TurnTracker {
  const existing = turnTrackers.get(ap)
  if (existing) return existing

  const tracker: TurnTracker = { inFlight: false, waiters: [] }
  turnTrackers.set(ap, tracker)

  const settle = () => {
    tracker.inFlight = false
    for (const wake of tracker.waiters.splice(0)) wake()
  }

  // Permanent, deliberately independent of whichever turn currently owns the
  // stream. A `result` that lands after its turn detached — the abort case —
  // still marks the CLI idle instead of leaking into the next turn's handler.
  ap.lineEmitter.on("line", (line: string) => {
    if (!tracker.inFlight) return
    if (isTerminalResultLine(line)) settle()
  })
  ap.lineEmitter.on("close", settle)

  return tracker
}

/** Call immediately before any stdin write that asks the CLI to do work. */
export function noteTurnStarted(ap: ActiveProcess): void {
  turnTracker(ap).inFlight = true
}

export function isTurnInFlight(ap: ActiveProcess): boolean {
  return turnTracker(ap).inFlight
}

/** Resolves true once the CLI is idle, false if it stayed busy past the timeout. */
export function awaitTurnIdle(
  ap: ActiveProcess,
  timeoutMs: number,
): Promise<boolean> {
  const tracker = turnTracker(ap)
  if (!tracker.inFlight) return Promise.resolve(true)

  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      const at = tracker.waiters.indexOf(wake)
      if (at >= 0) tracker.waiters.splice(at, 1)
      resolve(false)
    }, timeoutMs)
    tracker.waiters.push(wake)
  })
}

/**
 * Ask the CLI to abandon the in-flight turn, and wait for it to say it did.
 *
 * The CLI answers a stream-json `control_request` of subtype `interrupt` by
 * aborting the turn and emitting a terminal `result` with
 * `subtype: "error_during_execution"` almost immediately — so this normally
 * resolves in milliseconds.
 */
export function interruptTurn(
  ap: ActiveProcess,
  timeoutMs = TURN_INTERRUPT_TIMEOUT_MS,
): Promise<boolean> {
  if (!turnTracker(ap).inFlight) return Promise.resolve(true)

  // The interactive transport's stdin is a TUI, not a protocol endpoint —
  // a control request would be typed in as literal JSON. Wait it out instead.
  if (ap.interactive) {
    log.notice("interactive transport cannot be interrupted; waiting for turn")
    return awaitTurnIdle(ap, timeoutMs)
  }

  try {
    ap.proc.stdin?.write(
      JSON.stringify({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "interrupt" },
      }) + "\n",
    )
  } catch (error) {
    log.warn("failed to write interrupt control request", {
      error: error instanceof Error ? error.message : String(error),
    })
    return Promise.resolve(false)
  }

  return awaitTurnIdle(ap, timeoutMs)
}

function touch(key: string): void {
  const existing = activeProcesses.get(key)
  if (existing) {
    existing.lastUsedAt = Date.now()
    activeProcesses.delete(key)
    activeProcesses.set(key, existing)
  }
}

function evictIfNeeded(): void {
  while (activeProcesses.size >= MAX_ACTIVE_PROCESSES) {
    const oldestKey = activeProcesses.keys().next().value
    if (!oldestKey) break
    log.info("evicting LRU claude process", { sessionKey: oldestKey })
    deleteActiveProcess(oldestKey)
  }
}

export function getActiveProcess(key: string): ActiveProcess | undefined {
  const ap = activeProcesses.get(key)
  if (ap) touch(key)
  return ap
}

export function setActiveProcess(key: string, ap: ActiveProcess): void {
  ap.lastUsedAt = Date.now()
  activeProcesses.set(key, ap)
}

function detachActiveProcess(key: string): ActiveProcess | undefined {
  const ap = activeProcesses.get(key)
  if (!ap) return undefined
  activeProcesses.delete(key)
  void ap.proxyServer?.close()
  return ap
}

export function deleteActiveProcess(key: string): void {
  const ap = detachActiveProcess(key)
  ap?.proc.kill()
}

function hasProcessExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

function waitForProcessExit(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (hasProcessExited(proc)) return Promise.resolve(true)

  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      proc.off("exit", onExit)
      resolve(hasProcessExited(proc))
    }, timeoutMs)
    proc.once("exit", onExit)
  })
}

export async function deleteActiveProcessAndWait(
  key: string,
  options: {
    exitTimeoutMs?: number
    forceExitTimeoutMs?: number
  } = {},
): Promise<boolean> {
  const ap = detachActiveProcess(key)
  if (!ap || hasProcessExited(ap.proc)) return true

  const gracefulExit = waitForProcessExit(
    ap.proc,
    options.exitTimeoutMs ?? PROCESS_EXIT_TIMEOUT_MS,
  )
  ap.proc.kill()
  if (await gracefulExit) return true

  const forcedExit = waitForProcessExit(
    ap.proc,
    options.forceExitTimeoutMs ?? PROCESS_FORCE_EXIT_TIMEOUT_MS,
  )
  ap.proc.kill("SIGKILL")
  if (await forcedExit) return true

  log.warn("claude process did not exit; starting a fresh session", {
    sessionKey: key,
  })
  deleteClaudeSessionId(key)
  return false
}

/**
 * Drop CLI processes no chat has used in `ttlMs`. A turn still in flight is
 * always spared — `lastUsedAt` is stamped at turn *start*, so a long-running
 * turn would otherwise look idle and get killed mid-answer.
 *
 * Returns the reaped session keys (for tests and logging).
 */
export function reapIdleProcesses(
  ttlMs: number = IDLE_PROCESS_TTL_MS,
  now: number = Date.now(),
): string[] {
  const reaped: string[] = []

  for (const [key, ap] of [...activeProcesses]) {
    if (isTurnInFlight(ap)) continue

    // A process that predates stamping (or an ActiveProcess shim built
    // elsewhere) starts its clock now rather than being reaped immediately.
    if (ap.lastUsedAt === undefined) {
      ap.lastUsedAt = now
      continue
    }

    const idleMs = now - ap.lastUsedAt
    if (idleMs < ttlMs) continue

    log.info("reaping idle claude process", { sessionKey: key, idleMs })
    void deleteActiveProcessAndWait(key)
    reaped.push(key)
  }

  return reaped
}

let idleSweepTimer: ReturnType<typeof setInterval> | null = null

/** Idempotent. The timer is unref'd so it never holds opencode open. */
export function startIdleProcessReaper(): void {
  if (idleSweepTimer) return
  idleSweepTimer = setInterval(() => {
    reapIdleProcesses()
  }, IDLE_SWEEP_INTERVAL_MS)
  idleSweepTimer.unref?.()
}

/** Test-only. Stops the sweep so a test process can exit deterministically. */
export function stopIdleProcessReaper(): void {
  if (!idleSweepTimer) return
  clearInterval(idleSweepTimer)
  idleSweepTimer = null
}

/**
 * Release every CLI process belonging to one opencode chat, for `session.deleted`.
 *
 * Session keys are `cwd::model::scope::affinity` (see `sessionKey`), so the
 * affinity token is the trailing segment. `"default"` is the shared fallback
 * bucket used when no session id is known — matching on it would kill another
 * live chat's process, so it is deliberately skipped.
 */
export function deleteActiveProcessesForAffinity(affinity: string): string[] {
  if (!affinity || affinity === "default") return []

  const suffix = `::${affinity}`
  const released: string[] = []

  for (const key of [...activeProcesses.keys()]) {
    if (!key.endsWith(suffix)) continue
    log.info("releasing claude process for ended session", { sessionKey: key })
    void deleteActiveProcessAndWait(key)
    deleteClaudeSessionId(key)
    released.push(key)
  }

  return released
}

/**
 * Synchronous best-effort sweep for process exit. Node does not kill children
 * on exit, so without this a hard opencode shutdown reparents every live
 * `claude` to init. Must stay sync — `process.on("exit")` runs no async work.
 */
export function killAllActiveProcesses(): void {
  for (const key of [...activeProcesses.keys()]) {
    deleteActiveProcess(key)
  }
}

export function getClaudeSessionId(key: string): string | undefined {
  return claudeSessions.get(key)
}

export function setClaudeSessionId(key: string, sessionId: string): void {
  claudeSessions.set(key, sessionId)
}

export function deleteClaudeSessionId(key: string): void {
  const claudeSessionId = claudeSessions.get(key)
  if (claudeSessionId) clearLedger(claudeSessionId)
  claudeSessions.delete(key)
}

export function spawnClaudeProcess(
  cliPath: string,
  cliArgs: string[],
  cwd: string,
  sessionKey: string,
  proxyServer?: ProxyMcpServer | null,
  mcpHash?: string | null,
  systemPromptFile?: string,
  ignoreAnthropicApiKey?: boolean,
): ActiveProcess {
  evictIfNeeded()
  log.info("spawning new claude process", { cliPath, cliArgs, cwd, sessionKey })

  const proc = spawn(cliPath, cliArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: claudeSpawnEnv({ ignoreAnthropicApiKey }),
    shell: process.platform === "win32",
  })

  const lineEmitter = new EventEmitter()

  const rl = createInterface({ input: proc.stdout! })
  rl.on("line", (line: string) => {
    lineEmitter.emit("line", line)
  })
  rl.on("close", () => {
    lineEmitter.emit("close")
  })

  const ap: ActiveProcess = {
    proc,
    lineEmitter,
    proxyServer: proxyServer ?? null,
    mcpHash,
    systemPromptFile,
    lastUsedAt: Date.now(),
  }
  activeProcesses.set(sessionKey, ap)

  // Baseline 'error' listener so Node doesn't throw when the process emits
  // an error between stream turns (no per-stream listener attached then).
  proc.on("error", (err) => {
    log.error("claude process error", { sessionKey, error: err.message })
  })

  proc.on("exit", (code, signal) => {
    log.info("claude process exited", { code, signal, sessionKey })
    void proxyServer?.close()
    if (systemPromptFile) {
      void unlink(systemPromptFile).catch(() => {})
    }
    const ownsSessionKey = activeProcesses.get(sessionKey) === ap
    if (ownsSessionKey) activeProcesses.delete(sessionKey)
    if (ownsSessionKey && code !== 0 && code !== null) {
      log.info("process exited with error, clearing session", {
        code,
        sessionKey,
      })
      claudeSessions.delete(sessionKey)
    }
  })

  proc.stderr?.on("data", (data: Buffer) => {
    const stderr = data.toString()
    log.debug("stderr", { data: stderr.slice(0, 200) })

    // "No conversation found with session ID: <uuid>" is what `--resume`
    // prints for a purged transcript — note the lowercase "session ID",
    // which the capitalized match below does not catch.
    if (
      stderr.includes("No conversation found") ||
      (stderr.includes("Session ID") &&
        (stderr.includes("already in use") ||
          stderr.includes("not found") ||
          stderr.includes("invalid")))
    ) {
      if (activeProcesses.get(sessionKey) === ap) {
        log.warn("claude session ID error, clearing session", {
          sessionKey,
          error: stderr.slice(0, 200),
        })
        claudeSessions.delete(sessionKey)
      } else {
        log.debug("ignoring session ID error from stale claude process", {
          sessionKey,
        })
      }
    }
  })

  return ap
}

/**
 * Append `--resume <id>` to an already-built args vector when a Claude
 * conversation id is known for the session and the args don't already carry
 * a session flag. Used by `respawnActiveProcess` to resume the conversation
 * in a fresh child without rebuilding the whole (version-gated) args vector.
 * `--resume`, not `--session-id`: the latter means "create a NEW session
 * with this UUID" and the CLI rejects it with "Session ID ... is already in
 * use" whenever a transcript exists on disk — which is exactly the state a
 * mid-conversation respawn is in. If the wedged child died before writing
 * any transcript, `--resume` fails with "No conversation found with session
 * ID", which the stderr recovery matcher already catches (fresh-session
 * fallback).
 */
export function appendResumeIfNeeded(
  sessionKey: string,
  cliArgs: string[],
): string[] {
  if (cliArgs.includes("--resume") || cliArgs.includes("--session-id")) {
    return cliArgs
  }
  const sid = claudeSessions.get(sessionKey)
  if (!sid) return cliArgs
  return [...cliArgs, "--resume", sid]
}

/**
 * Replace a wedged reused process with a fresh one, resuming the same
 * Claude conversation. Used by the doStream start-watchdog when a reused
 * process produces no stdout within a grace window after a fresh-turn
 * envelope write — observed after a very long proxy-blocked tool call
 * (e.g. a multi-minute `task` subagent). Before the per-tool proxy timeout
 * fix this was masked because the flat 10-minute ceiling ended the turn
 * first; now that the task proxy blocks and returns successfully, resuming
 * a reused child after such a long wait can leave it silent on stdout.
 *
 * Reuses the existing proxy server, system-prompt file, and MCP hash (their
 * handles are already baked into `cliArgs`' `--mcp-config`/append-prompt
 * paths), so this only swaps the child process. The old child's exit
 * handler is silenced before kill so it doesn't close the proxy server we
 * are reusing; the new child gets its own exit handler from
 * `spawnClaudeProcess`. `claudeSessions` is left intact so the respawn can
 * add `--resume` (see `appendResumeIfNeeded`).
 *
 * Returns the new `ActiveProcess`, or `undefined` if there was no active
 * process for the key (caller should treat that as "nothing to respawn").
 */
export function respawnActiveProcess(
  sessionKey: string,
  cliPath: string,
  cliArgs: string[],
  cwd: string,
  ignoreAnthropicApiKey?: boolean,
): ActiveProcess | undefined {
  const old = activeProcesses.get(sessionKey)
  if (!old) return undefined
  activeProcesses.delete(sessionKey)
  // Silence the old exit handler so it doesn't close the proxy server,
  // unlink the system-prompt file, or touch claudeSessions on its way out
  // — those handles are reused by the new child. spawnClaudeProcess wires
  // a fresh exit handler for the respawned child.
  old.proc.removeAllListeners("exit")
  try {
    old.proc.kill()
  } catch {}
  return spawnClaudeProcess(
    cliPath,
    appendResumeIfNeeded(sessionKey, cliArgs),
    cwd,
    sessionKey,
    old.proxyServer,
    old.mcpHash,
    old.systemPromptFile,
    ignoreAnthropicApiKey,
  )
}

export function buildCliArgs(opts: {
  sessionKey: string
  skipPermissions: boolean
  includeSessionId?: boolean
  model?: string
  permissionMode?: string
  mcpConfig?: string | string[]
  strictMcpConfig?: boolean
  pluginDirs?: string[]
  disallowedTools?: string[]
  appendSystemPromptFile?: string
  thinking?: "enabled" | "disabled"
  thinkingDisplay?: "summarized" | "omitted"
  cliVersion?: CliVersion | null
}): string[] {
  const {
    sessionKey,
    skipPermissions,
    includeSessionId = true,
    model,
    permissionMode,
    mcpConfig,
    strictMcpConfig,
    pluginDirs,
    disallowedTools,
    appendSystemPromptFile,
    thinking,
    thinkingDisplay,
    cliVersion,
  } = opts
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
  ]

  if (model) {
    args.push("--model", model)
  }

  if (permissionMode) {
    args.push("--permission-mode", permissionMode)
  }

  // `--session-id` means "create a NEW session with this UUID" and the CLI
  // exits with "Session ID ... is already in use" whenever a transcript for
  // that ID already exists on disk. Continuing an existing session requires
  // `--resume` (which keeps the same session ID in print mode).
  if (includeSessionId) {
    const sessionId = claudeSessions.get(sessionKey)
    if (sessionId && !activeProcesses.has(sessionKey)) {
      args.push("--resume", sessionId)
    }
  }

  if (mcpConfig) {
    const configs = Array.isArray(mcpConfig) ? mcpConfig : [mcpConfig]
    const filtered = configs.filter((c) => typeof c === "string" && c.length > 0)
    if (filtered.length > 0) {
      args.push("--mcp-config", ...filtered)
    }
  }

  if (strictMcpConfig) {
    args.push("--strict-mcp-config")
  }

  // `--plugin-dir` is repeatable and scoped to this session only. Callers
  // pass an already-validated list (see skill-bridge.ts), which is empty
  // whenever the CLI is too old to accept the flag.
  if (pluginDirs && pluginDirs.length > 0) {
    for (const dir of pluginDirs) {
      args.push("--plugin-dir", dir)
    }
  }

  if (disallowedTools && disallowedTools.length > 0) {
    args.push("--disallowedTools", ...disallowedTools)
  }

  // `--thinking` is only present from Claude Code 2.x onward; gate so
  // pre-2.x binaries don't crash with a parse error. Unknown version →
  // skip (the spawn still works, the user just doesn't get extended
  // thinking until they upgrade).
  if (thinking && cliSupportsThinking(cliVersion ?? null)) {
    args.push("--thinking", thinking)
  }

  // `--thinking-display` was added in Claude Code 2.1.142. Older CLIs
  // reject it with a parse error, so gate on detected version. When
  // version is unknown (detection failed), be conservative and skip.
  if (thinkingDisplay && cliSupportsThinkingDisplay(cliVersion ?? null)) {
    args.push("--thinking-display", thinkingDisplay)
  }

  if (appendSystemPromptFile) {
    args.push("--append-system-prompt-file", appendSystemPromptFile)
  }

  if (skipPermissions) {
    args.push("--dangerously-skip-permissions")
  }

  return args
}

/**
 * Build a session key that includes both cwd and model,
 * so different models get separate processes.
 */
export function sessionKey(cwd: string, modelId: string): string {
  return `${cwd}::${modelId}`
}
