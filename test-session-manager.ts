import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import { test } from "node:test"
import { spawn, type ChildProcess } from "node:child_process"
import {
  deleteActiveProcess,
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getActiveProcess,
  getClaudeSessionId,
  setActiveProcess,
  setClaudeSessionId,
  spawnClaudeProcess,
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
