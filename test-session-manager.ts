import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import { test } from "node:test"
import { spawn, type ChildProcess } from "node:child_process"
import {
  buildCliArgs,
  deleteActiveProcess,
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getActiveProcess,
  getClaudeSessionId,
  setActiveProcess,
  setClaudeSessionId,
  spawnClaudeProcess,
  noteTurnStarted,
  isTurnInFlight,
  interruptTurn,
  awaitTurnIdle,
  reapIdleProcesses,
  deleteActiveProcessesForAffinity,
  killAllActiveProcesses,
  sessionKey,
  type ActiveProcess,
} from "./src/session-manager.js"

function fakeActiveProcess(options: { exitOn: NodeJS.Signals; delayMs: number }): {
  activeProcess: ActiveProcess
  signals: NodeJS.Signals[]
} {
  const proc = new EventEmitter() as ChildProcess
  const signals: NodeJS.Signals[] = []
  Object.assign(proc, {
    exitCode: null,
    signalCode: null,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      signals.push(signal)
      if (signal === options.exitOn) {
        setTimeout(() => {
          Object.defineProperty(proc, "signalCode", {
            configurable: true,
            value: signal,
          })
          proc.emit("exit", null, signal)
        }, options.delayMs)
      }
      return true
    },
  })

  return {
    activeProcess: {
      proc,
      lineEmitter: new EventEmitter(),
      proxyServer: null,
    },
    signals,
  }
}

test("deleteActiveProcessAndWait waits for the old session owner", async () => {
  const key = "wait-for-session-owner"
  const { activeProcess, signals } = fakeActiveProcess({
    exitOn: "SIGTERM",
    delayMs: 25,
  })
  setActiveProcess(key, activeProcess)
  setClaudeSessionId(key, "claude-session")

  let settled = false
  const pending = deleteActiveProcessAndWait(key, {
    exitTimeoutMs: 200,
    forceExitTimeoutMs: 100,
  }).then((result) => {
    settled = true
    return result
  })

  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(settled, false)
  assert.equal(await pending, true)
  assert.deepEqual(signals, ["SIGTERM"])
  assert.equal(getActiveProcess(key), undefined)
  assert.equal(getClaudeSessionId(key), "claude-session")
  deleteClaudeSessionId(key)
})

test("deleteActiveProcessAndWait escalates before reusing a session ID", async () => {
  const key = "force-session-owner-exit"
  const { activeProcess, signals } = fakeActiveProcess({
    exitOn: "SIGKILL",
    delayMs: 5,
  })
  setActiveProcess(key, activeProcess)

  assert.equal(
    await deleteActiveProcessAndWait(key, {
      exitTimeoutMs: 5,
      forceExitTimeoutMs: 100,
    }),
    true,
  )
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
})

test("buildCliArgs resumes a remembered session with --resume", () => {
  const key = "resume-args"
  setClaudeSessionId(key, "11111111-1111-4111-8111-111111111111")
  try {
    const args = buildCliArgs({ sessionKey: key, skipPermissions: true })
    assert.equal(
      args[args.indexOf("--resume") + 1],
      "11111111-1111-4111-8111-111111111111",
    )
    assert.equal(args.includes("--session-id"), false)
  } finally {
    deleteClaudeSessionId(key)
  }
})

test("buildCliArgs skips --resume while the session owner is alive", () => {
  const key = "resume-args-live"
  setClaudeSessionId(key, "22222222-2222-4222-8222-222222222222")
  const { activeProcess } = fakeActiveProcess({ exitOn: "SIGTERM", delayMs: 0 })
  setActiveProcess(key, activeProcess)
  try {
    const args = buildCliArgs({ sessionKey: key, skipPermissions: true })
    assert.equal(args.includes("--resume"), false)
    assert.equal(args.includes("--session-id"), false)
  } finally {
    deleteActiveProcess(key)
    deleteClaudeSessionId(key)
  }
})

test("a resume failure on stderr clears the remembered session ID", async () => {
  const key = "resume-error-stderr"
  setClaudeSessionId(key, "purged-session")
  spawnClaudeProcess(
    process.execPath,
    [
      "-e",
      "console.error('No conversation found with session ID: purged-session'); setInterval(() => {}, 1000)",
    ],
    process.cwd(),
    key,
  )
  try {
    const deadline = Date.now() + 2000
    while (getClaudeSessionId(key) !== undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(getClaudeSessionId(key), undefined)
  } finally {
    deleteActiveProcess(key)
    deleteClaudeSessionId(key)
  }
})

test("an exiting stale process cannot delete its replacement", async () => {
  const key = "stale-process-exit"
  const first = spawnClaudeProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    process.cwd(),
    key,
  )
  const replacementProc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"])
  const replacement: ActiveProcess = {
    proc: replacementProc,
    lineEmitter: new EventEmitter(),
    proxyServer: null,
  }

  try {
    setActiveProcess(key, replacement)
    first.proc.kill()
    await once(first.proc, "exit")
    assert.equal(getActiveProcess(key), replacement)
  } finally {
    deleteActiveProcess(key)
    deleteClaudeSessionId(key)
  }
})

// --- turn lifecycle -------------------------------------------------------

function fakeTurnProcess(options: { interactive?: boolean } = {}): {
  activeProcess: ActiveProcess
  writes: string[]
  emitLine: (line: string) => void
} {
  const writes: string[] = []
  const proc = new EventEmitter() as ChildProcess
  Object.assign(proc, {
    exitCode: null,
    signalCode: null,
    stdin: {
      write(chunk: string) {
        writes.push(chunk)
        return true
      },
    },
  })
  const lineEmitter = new EventEmitter()

  return {
    activeProcess: {
      proc,
      lineEmitter,
      proxyServer: null,
      ...(options.interactive ? { interactive: true } : {}),
    },
    writes,
    emitLine: (line: string) => lineEmitter.emit("line", line),
  }
}

const RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
})

test("a terminal result line ends the in-flight turn", () => {
  const { activeProcess, emitLine } = fakeTurnProcess()

  assert.equal(isTurnInFlight(activeProcess), false)
  noteTurnStarted(activeProcess)
  assert.equal(isTurnInFlight(activeProcess), true)

  // Mid-turn traffic must not be mistaken for the terminal result — including
  // an assistant message that merely mentions the word.
  emitLine(JSON.stringify({ type: "stream_event", event: { delta: {} } }))
  emitLine(JSON.stringify({ type: "assistant", text: 'the "result" is 42' }))
  emitLine("not json at all")
  assert.equal(isTurnInFlight(activeProcess), true)

  emitLine(RESULT_LINE)
  assert.equal(isTurnInFlight(activeProcess), false)
})

test("interruptTurn sends a control request and resolves on the result", async () => {
  const { activeProcess, writes, emitLine } = fakeTurnProcess()
  noteTurnStarted(activeProcess)

  const pending = interruptTurn(activeProcess, 1_000)

  assert.equal(writes.length, 1)
  const sent = JSON.parse(writes[0])
  assert.equal(sent.type, "control_request")
  assert.equal(sent.request.subtype, "interrupt")
  assert.equal(typeof sent.request_id, "string")
  assert.ok(writes[0].endsWith("\n"), "control request must be newline-delimited")

  emitLine(RESULT_LINE)
  assert.equal(await pending, true)
  assert.equal(isTurnInFlight(activeProcess), false)
})

test("interruptTurn is a no-op when no turn is in flight", async () => {
  const { activeProcess, writes } = fakeTurnProcess()
  assert.equal(await interruptTurn(activeProcess, 1_000), true)
  assert.deepEqual(writes, [])
})

test("interruptTurn reports failure when the CLI stays wedged", async () => {
  const { activeProcess, writes } = fakeTurnProcess()
  noteTurnStarted(activeProcess)

  assert.equal(await interruptTurn(activeProcess, 20), false)
  assert.equal(writes.length, 1)
  // Still in flight — callers proceed, but the log says why.
  assert.equal(isTurnInFlight(activeProcess), true)
})

test("interruptTurn never types a control request into the interactive TUI", async () => {
  const { activeProcess, writes, emitLine } = fakeTurnProcess({ interactive: true })
  noteTurnStarted(activeProcess)

  const pending = interruptTurn(activeProcess, 1_000)
  assert.deepEqual(writes, [], "interactive stdin is a terminal, not a protocol")

  emitLine(RESULT_LINE)
  assert.equal(await pending, true)
})

test("awaitTurnIdle resolves immediately for an idle process", async () => {
  const { activeProcess } = fakeTurnProcess()
  assert.equal(await awaitTurnIdle(activeProcess, 20), true)
})

test("a closed stream releases turn-idle waiters", async () => {
  const { activeProcess } = fakeTurnProcess()
  noteTurnStarted(activeProcess)

  const pending = awaitTurnIdle(activeProcess, 1_000)
  activeProcess.lineEmitter.emit("close")

  assert.equal(await pending, true)
  assert.equal(isTurnInFlight(activeProcess), false)
})

// --- idle reaping / session release ------------------------------------

function reapableProcess(): { activeProcess: ActiveProcess; killed: () => boolean } {
  const { activeProcess, signals } = fakeActiveProcess({
    exitOn: "SIGTERM",
    delayMs: 1,
  })
  return { activeProcess, killed: () => signals.length > 0 }
}

test("reapIdleProcesses drops a process nothing has used past the TTL", () => {
  const key = "reap-idle-past-ttl"
  const { activeProcess, killed } = reapableProcess()
  setActiveProcess(key, activeProcess)
  activeProcess.lastUsedAt = 1_000

  const reaped = reapIdleProcesses(60_000, 1_000 + 60_001)

  assert.ok(reaped.includes(key))
  assert.equal(killed(), true)
  assert.equal(getActiveProcess(key), undefined)
})

test("reapIdleProcesses spares a process still inside the TTL", () => {
  const key = "reap-idle-inside-ttl"
  const { activeProcess, killed } = reapableProcess()
  setActiveProcess(key, activeProcess)
  activeProcess.lastUsedAt = 1_000

  const reaped = reapIdleProcesses(60_000, 1_000 + 59_999)

  assert.deepEqual(reaped, [])
  assert.equal(killed(), false)
  assert.ok(getActiveProcess(key))
  deleteActiveProcess(key)
})

// lastUsedAt is stamped at turn *start*, so a turn that runs longer than the
// TTL would otherwise be killed mid-answer.
test("reapIdleProcesses spares a turn still in flight", () => {
  const key = "reap-idle-in-flight"
  const { activeProcess, killed } = reapableProcess()
  setActiveProcess(key, activeProcess)
  activeProcess.lastUsedAt = 1_000
  noteTurnStarted(activeProcess)

  const reaped = reapIdleProcesses(60_000, 1_000 + 600_000)

  assert.deepEqual(reaped, [])
  assert.equal(killed(), false)
  deleteActiveProcess(key)
})

test("getActiveProcess refreshes the idle clock", () => {
  const key = "reap-idle-touch"
  const { activeProcess } = reapableProcess()
  setActiveProcess(key, activeProcess)
  activeProcess.lastUsedAt = 1_000

  getActiveProcess(key)

  assert.ok((activeProcess.lastUsedAt ?? 0) > 1_000)
  assert.deepEqual(reapIdleProcesses(60_000, Date.now()), [])
  deleteActiveProcess(key)
})

test("deleteActiveProcessesForAffinity releases only that chat's processes", () => {
  const mine = sessionKey("/repo", "claude-opus-5::tools::ses_mine")
  const theirs = sessionKey("/repo", "claude-opus-5::tools::ses_theirs")
  const mineOther = sessionKey("/repo", "claude-haiku-4-5::no-tools::ses_mine")

  const a = reapableProcess()
  const b = reapableProcess()
  const c = reapableProcess()
  setActiveProcess(mine, a.activeProcess)
  setActiveProcess(theirs, b.activeProcess)
  setActiveProcess(mineOther, c.activeProcess)
  setClaudeSessionId(mine, "claude-session-mine")

  const released = deleteActiveProcessesForAffinity("ses_mine")

  assert.deepEqual(released.sort(), [mine, mineOther].sort())
  assert.equal(a.killed(), true)
  assert.equal(c.killed(), true)
  assert.equal(b.killed(), false)
  assert.equal(getClaudeSessionId(mine), undefined)
  assert.ok(getActiveProcess(theirs))
  deleteActiveProcess(theirs)
})

// "default" is the shared fallback bucket used when no session id is known,
// so matching on it would kill a different live chat's process.
test("deleteActiveProcessesForAffinity skips the shared default bucket", () => {
  const key = sessionKey("/repo", "claude-opus-5::tools::default")
  const { activeProcess, killed } = reapableProcess()
  setActiveProcess(key, activeProcess)

  assert.deepEqual(deleteActiveProcessesForAffinity("default"), [])
  assert.equal(killed(), false)
  deleteActiveProcess(key)
})

test("killAllActiveProcesses leaves nothing behind for process exit", () => {
  const a = reapableProcess()
  const b = reapableProcess()
  setActiveProcess("kill-all-a", a.activeProcess)
  setActiveProcess("kill-all-b", b.activeProcess)

  killAllActiveProcesses()

  assert.equal(a.killed(), true)
  assert.equal(b.killed(), true)
  assert.equal(getActiveProcess("kill-all-a"), undefined)
  assert.equal(getActiveProcess("kill-all-b"), undefined)
})
