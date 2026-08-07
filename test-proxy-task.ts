import { test } from "node:test"
import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin, { createClaudeCode } from "./src/index.js"
import {
  createProxyMcpServer,
  DEFAULT_PROXY_TOOLS,
  disallowedToolFlags,
  isExpectedCleanupError,
  resolveProxyCallTimeoutMs,
  resolveProxyClientCeilingMs,
  MAX_PROXY_TIMEOUT_MS,
  SERVER_CLOSED_MESSAGE,
  CLIENT_GONE_MESSAGE,
  TASK_BATCH_TOOL_NAME,
} from "./src/proxy-mcp.js"
import {
  getPendingProxyCalls,
  onPendingProxyCall,
  queuePendingProxyCall,
  rejectAllPendingProxyCallsForSession,
  rejectPendingProxyCallById,
  resolvePendingProxyCallById,
  type PendingProxyCall,
} from "./src/proxy-broker.js"
import { deleteActiveProcess, sessionKey } from "./src/session-manager.js"

const TASK_INPUT = {
  description: "Inspect provider flow",
  prompt: "Verify the provider delegates this task through opencode.",
  subagent_type: "general",
  task_id: "task-existing",
  command: "/delegate",
  background: true,
}
const PARALLEL_TASK_INPUT = {
  ...TASK_INPUT,
  description: "Inspect parallel flow",
  task_id: "task-parallel",
  background: false,
}
const TASK_BATCH_INPUT = {
  tasks: [TASK_INPUT, PARALLEL_TASK_INPUT],
}

function modelProxyTools(settings: { proxyTools?: string[] } = {}) {
  const provider = createClaudeCode(settings)
  const model = provider.languageModel("claude-haiku-4-5") as unknown as {
    config: { proxyTools?: string[] }
  }
  return model.config.proxyTools
}

function createFakeTaskCli(
  mode:
    | "normal"
    | "nonpartial-batch"
    | "race"
    | "batch"
    | "delayed-message-stop"
    | "late-independent-call"
    | "missing-batch-call"
    | "duplicate"
    | "error"
    | "abort"
    | "followup"
    | "task-batch-followup",
) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-proxy-task-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const messageStopMarker = join(cwd, "message-stop-emitted")
  const source = `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.142\\n")
  process.exit(0)
}

const args = process.argv.slice(2)
const configIndex = args.indexOf("--mcp-config")
let proxyUrl
if (configIndex >= 0) {
  for (let index = configIndex + 1; index < args.length; index++) {
    const value = args[index]
    if (value.startsWith("--")) break
    try {
      const config = JSON.parse(fs.readFileSync(value, "utf8"))
      proxyUrl = config.mcpServers?.opencode_proxy?.url ?? proxyUrl
    } catch {}
  }
}

if (!proxyUrl) {
  process.stderr.write("missing opencode proxy URL\\n")
  process.exit(2)
}

const mode = ${JSON.stringify(mode)}
const messageStopMarker = ${JSON.stringify(messageStopMarker)}
const taskInput = ${JSON.stringify(TASK_INPUT)}
const secondTaskInput = ${JSON.stringify(PARALLEL_TASK_INPUT)}
const taskBatchInput = ${JSON.stringify(TASK_BATCH_INPUT)}
const usesTaskBatch = mode === "task-batch-followup"
const hasSecondTask =
  mode === "batch" ||
  mode === "late-independent-call" ||
  mode === "nonpartial-batch" ||
  mode === "missing-batch-call"
const assistant = {
  type: "assistant",
  session_id: "fake-session",
  message: {
    role: "assistant",
    stop_reason: "end_turn",
    content: [
      { type: "text", text: "I found the relevant files and will delegate the focused check." },
      {
        type: "tool_use",
        id: usesTaskBatch ? "claude-proxy-task-batch" : "claude-proxy-task",
        name: usesTaskBatch
          ? "mcp__opencode_proxy__task_batch"
          : "mcp__opencode_proxy__task",
        input: usesTaskBatch ? taskBatchInput : taskInput,
      },
      ...(hasSecondTask
        ? [{
            type: "tool_use",
            id: "claude-proxy-task-2",
            name: "mcp__opencode_proxy__task",
            input: secondTaskInput,
          }]
        : []),
    ],
  },
}
const result = {
  type: "result",
  subtype: "success",
  session_id: "fake-session",
  duration_ms: 1,
  num_turns: 1,
  is_error: false,
  usage: { input_tokens: 1, output_tokens: 1 },
}

function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\\n")
}

function emitTaskBlock(index, id, input, toolName = "task") {
  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id,
        name: "mcp__opencode_proxy__" + toolName,
      },
    },
  })
  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(input),
      },
    },
  })
  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: { type: "content_block_stop", index },
  })
}

function emitMessageEnd() {
  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    },
  })
  fs.writeFileSync(messageStopMarker, "")
  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: { type: "message_stop" },
  })
  emit(assistant)
}

function emitAssistant() {
  if (mode === "abort") {
    emit({
      ...assistant,
      message: {
        ...assistant.message,
        content: assistant.message.content.filter((block) => block.type === "tool_use"),
      },
    })
    return
  }
  if (mode === "normal" || mode === "nonpartial-batch") {
    emit(assistant)
    return
  }

  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: { type: "message_start" },
  })
  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  })
  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: "I found the relevant files and will delegate the focused check.",
      },
    },
  })
  emit({
    type: "stream_event",
    session_id: "fake-session",
    event: { type: "content_block_stop", index: 0 },
  })
  emitTaskBlock(
    1,
    usesTaskBatch ? "claude-proxy-task-batch" : "claude-proxy-task",
    usesTaskBatch ? taskBatchInput : taskInput,
    usesTaskBatch ? "task_batch" : "task",
  )
  if (mode === "delayed-message-stop") return
  if (
    mode === "batch" ||
    mode === "missing-batch-call"
  ) {
    emitTaskBlock(2, "claude-proxy-task-2", secondTaskInput)
  }
  emitMessageEnd()
}

async function callTask(input = taskInput, id = 1) {
  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "task", arguments: input },
    }),
  })
  return response.json()
}

async function callTaskBatch() {
  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "task-batch-1",
      method: "tools/call",
      params: { name: "task_batch", arguments: taskBatchInput },
    }),
  })
  return response.json()
}

let handled = false
readline.createInterface({ input: process.stdin }).on("line", () => {
  if (handled) return
  handled = true
  emitAssistant()
  if (mode === "abort") {
    void callTask().catch(() => {})
    return
  }
  if (mode === "task-batch-followup") {
    void callTaskBatch()
      .then((body) => {
        const responseText = body.result?.content?.[0]?.text ??
          JSON.stringify(body.error)
        emit({
          type: "assistant",
          session_id: "fake-session",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{
              type: "text",
              text: "Batch parent received: " + responseText,
            }],
          },
        })
        emit({ ...result, num_turns: 2 })
      })
      .catch(() => {})
    return
  }
  if (mode === "delayed-message-stop") {
    void callTask().catch(() => {})
    setTimeout(() => {
      emitMessageEnd()
      setTimeout(() => emit(result), 50)
    }, 300)
    return
  }
  if (mode === "late-independent-call") {
    void callTask().catch(() => {})
    setTimeout(
      () => void callTask(secondTaskInput, 2).catch(() => {}),
      300,
    )
    return
  }
  if (mode === "missing-batch-call") {
    void callTask().catch(() => {})
    return
  }
  if (mode === "nonpartial-batch") {
    void callTask().catch(() => {})
    setTimeout(() => void callTask(secondTaskInput, 2).catch(() => {}), 25)
    return
  }
  if (mode === "race") {
    emit(result)
    setTimeout(() => void callTask().catch(() => {}), 25)
    return
  }
  if (mode === "error") {
    emit({ ...result, is_error: true, result: "fake task transport error" })
    return
  }
  if (mode === "batch") {
    void callTask().catch(() => {})
    setTimeout(() => void callTask(secondTaskInput, 2).catch(() => {}), 25)
    setTimeout(() => emit(result), 50)
    return
  }
  if (mode === "duplicate") {
    void callTask().catch(() => {})
    setTimeout(() => emit(result), 30)
    setTimeout(() => emit(result), 40)
    return
  }
  if (mode === "followup") {
    void callTask()
      .then((body) => {
        emit({
          type: "assistant",
          session_id: "fake-session",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{
              type: "text",
              text: "Parent received: " + body.result.content[0].text,
            }],
          },
        })
        emit({ ...result, num_turns: 2 })
      })
      .catch(() => {})
    setTimeout(() => emit(result), 100)
    return
  }
  void callTask().catch(() => {})
  setTimeout(() => emit(result), 100)
})
`
  writeFileSync(cliPath, source)
  chmodSync(cliPath, 0o755)
  return { cliPath, cwd, messageStopMarker }
}

async function streamTaskBoundary(
  mode:
    | "normal"
    | "nonpartial-batch"
    | "race"
    | "batch"
    | "delayed-message-stop"
    | "late-independent-call"
    | "missing-batch-call"
    | "duplicate"
    | "error",
) {
  const fake = createFakeTaskCli(mode)
  const modelId = `claude-test-task-${mode}`
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default`)

  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Task"],
    }).languageModel(modelId)
    const response = await model.doStream({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "Delegate the focused provider check." }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "task",
          description: "Delegate work to an opencode subagent",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    } as any)

    const parts: any[] = []
    for await (const part of response.stream) parts.push(part)
    return {
      parts,
      pending: getPendingProxyCalls(sk).map((call) => ({ ...call })),
      messageStopEmitted: existsSync(fake.messageStopMarker),
    }
  } finally {
    for (const call of getPendingProxyCalls(sk)) {
      resolvePendingProxyCallById(call.toolCallId, {
        kind: "text",
        text: "test cleanup",
      })
    }
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
}

function assertNativeTaskBoundary(
  parts: any[],
  pending: any[],
  expectedInputs = [TASK_INPUT],
) {
  const taskCalls = parts.filter(
    (part) => part.type === "tool-call" && part.toolName === "task",
  )
  assert.equal(taskCalls.length, expectedInputs.length)
  assert.ok(taskCalls.every((call) => call.providerExecuted === false))
  assert.deepEqual(
    taskCalls.map((call) => JSON.parse(call.input)),
    expectedInputs,
  )

  const finishes = parts.filter((part) => part.type === "finish")
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0].finishReason.unified, "tool-calls")

  const textIndex = parts.findIndex((part) => part.type === "text-delta")
  const taskIndex = parts.indexOf(taskCalls[0])
  assert.ok(textIndex >= 0)
  assert.ok(textIndex < taskIndex)

  assert.equal(pending.length, expectedInputs.length)
  assert.ok(pending.every((call) => call.toolName === "task"))
  assert.deepEqual(
    pending.map((call) => call.input),
    expectedInputs,
  )
}

async function postRpc(url: string, request: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  })
  if (response.status === 204) return { status: 204, body: null }
  return { status: response.status, body: await response.json() as any }
}

function waitForBrokerCalls(sessionKey: string, count: number) {
  return new Promise<PendingProxyCall[]>((resolve) => {
    const calls: PendingProxyCall[] = []
    const unsubscribe = onPendingProxyCall(sessionKey, (call) => {
      calls.push(call)
      if (calls.length !== count) return
      unsubscribe()
      resolve(calls)
    })
  })
}

test("default provider proxies Task through opencode", () => {
  assert.deepEqual(modelProxyTools(), [
    "Bash",
    "Edit",
    "Write",
    "WebFetch",
    "Task",
  ])
})

test("explicit proxyTools overrides preserve custom selection and empty opt-out", () => {
  assert.deepEqual(modelProxyTools({ proxyTools: ["Task"] }), ["Task"])
  assert.deepEqual(modelProxyTools({ proxyTools: [] }), [])
})

test("opencode provider registration defaults Task without overriding proxyTools", async () => {
  const hooks = await plugin.server({})
  assert.equal("tool" in hooks, false)

  const defaults: any = {}
  await hooks.config?.(defaults)
  assert.deepEqual(defaults.provider["claude-code"].options.proxyTools, [
    "Bash",
    "Edit",
    "Write",
    "WebFetch",
    "Task",
  ])

  const explicit: any = {
    provider: {
      "claude-code": {
        options: { proxyTools: [] },
      },
    },
  }
  await hooks.config?.(explicit)
  assert.deepEqual(explicit.provider["claude-code"].options.proxyTools, [])
})

test("parent and child calls retain distinct opencode session affinity", async () => {
  const hooks = await plugin.server({})
  const parentOutput: any = {}
  const childOutput: any = {}

  await hooks["chat.params"]?.(
    {
      sessionID: "session-parent",
      agent: "build",
      model: { providerID: "claude-code" } as any,
    },
    parentOutput,
  )
  await hooks["chat.params"]?.(
    {
      sessionID: "session-child",
      agent: "general",
      model: { providerID: "claude-code" } as any,
    },
    childOutput,
  )

  assert.equal(parentOutput.options.opencodeSessionID, "session-parent")
  assert.equal(childOutput.options.opencodeSessionID, "session-child")
  assert.notEqual(
    parentOutput.options.opencodeSessionID,
    childOutput.options.opencodeSessionID,
  )
})

test("Task proxy schema matches current opencode TaskTool fields", () => {
  const task = DEFAULT_PROXY_TOOLS.find((tool) => tool.name === "task")
  const taskBatch = DEFAULT_PROXY_TOOLS.find(
    (tool) => tool.name === TASK_BATCH_TOOL_NAME,
  )
  assert.ok(task)
  assert.ok(taskBatch)
  assert.match(task.description, /use task_batch/)
  assert.match(taskBatch.description, /required concurrency path/)

  const properties = task.inputSchema.properties as Record<
    string,
    Record<string, unknown>
  >
  assert.deepEqual(Object.keys(properties).sort(), [
    "background",
    "command",
    "description",
    "prompt",
    "subagent_type",
    "task_id",
  ])
  assert.equal(properties.background.type, "boolean")
  assert.deepEqual(task.inputSchema.required, [
    "description",
    "prompt",
    "subagent_type",
  ])
  const batchTasks = taskBatch.inputSchema.properties.tasks as Record<
    string,
    any
  >
  assert.equal(batchTasks.type, "array")
  assert.equal(batchTasks.minItems, 2)
  assert.deepEqual(batchTasks.items.required, task.inputSchema.required)
  assert.deepEqual(
    Object.keys(batchTasks.items.properties).sort(),
    Object.keys(properties).sort(),
  )
  assert.deepEqual(disallowedToolFlags([taskBatch]), ["Agent"])
  assert.deepEqual(disallowedToolFlags([task, taskBatch]), ["Agent"])
  assert.equal(
    resolveProxyCallTimeoutMs(TASK_BATCH_TOOL_NAME, undefined, undefined),
    0,
  )
})

test("task_batch rejects malformed arrays before creating a pending call", async () => {
  const taskBatch = DEFAULT_PROXY_TOOLS.find(
    (tool) => tool.name === TASK_BATCH_TOOL_NAME,
  )
  assert.ok(taskBatch)
  const server = await createProxyMcpServer([taskBatch])
  let callCount = 0
  server.calls.on("call", () => callCount++)

  try {
    for (const [index, input] of [
      { tasks: [] },
      { tasks: [TASK_INPUT] },
      { tasks: [TASK_INPUT, null] },
      {
        tasks: [
          TASK_INPUT,
          { description: "Missing prompt", subagent_type: "general" },
        ],
      },
    ].entries()) {
      const response = await postRpc(server.url, {
        jsonrpc: "2.0",
        id: `invalid-batch-${index}`,
        method: "tools/call",
        params: { name: TASK_BATCH_TOOL_NAME, arguments: input },
      })
      assert.equal(response.body.result.isError, true)
      assert.match(response.body.result.content[0].text, /task_batch/)
    }
    assert.equal(callCount, 0)
  } finally {
    await server.close()
  }
})

test("proxy MCP initializes, lists Task, and resolves it through the broker", async () => {
  const task = DEFAULT_PROXY_TOOLS.find((tool) => tool.name === "task")
  assert.ok(task)
  assert.deepEqual(disallowedToolFlags([task]), ["Agent"])

  const brokerSession = `proxy-http-${Date.now()}`
  const server = await createProxyMcpServer([task])
  const forwardCall = (call: any) => queuePendingProxyCall(brokerSession, call)
  server.calls.on("call", forwardCall)
  try {
    const generatedConfig = JSON.parse(readFileSync(server.configPath(), "utf8"))
    // Task is unlimited server-side, but Claude rejects timeout:0 in the MCP
    // config, so advertise the largest positive client ceiling instead.
    assert.equal(
      generatedConfig.mcpServers.opencode_proxy.timeout,
      resolveProxyClientCeilingMs(undefined),
    )
    assert.equal(resolveProxyClientCeilingMs(undefined), MAX_PROXY_TIMEOUT_MS)

    const initialized = await postRpc(server.url, {
      jsonrpc: "2.0",
      id: "initialize-1",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "integration-test", version: "1.0.0" },
      },
    })
    assert.equal(initialized.body.id, "initialize-1")
    assert.equal(initialized.body.result.serverInfo.name, "opencode_proxy")

    const notification = await postRpc(server.url, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })
    assert.equal(notification.status, 204)

    const listed = await postRpc(server.url, {
      jsonrpc: "2.0",
      id: "list-1",
      method: "tools/list",
    })
    assert.equal(listed.body.id, "list-1")
    assert.deepEqual(
      listed.body.result.tools.map((tool: any) => tool.name),
      ["task"],
    )

    const brokerCalls = waitForBrokerCalls(brokerSession, 1)
    const callResponse = postRpc(server.url, {
      jsonrpc: "2.0",
      id: "task-1",
      method: "tools/call",
      params: { name: "task", arguments: TASK_INPUT },
    })
    const [call] = await brokerCalls

    assert.equal(call.toolName, "task")
    assert.deepEqual(call.input, TASK_INPUT)
    assert.equal(getPendingProxyCalls(brokerSession)[0].toolCallId, call.toolCallId)
    assert.equal(
      resolvePendingProxyCallById(call.toolCallId, {
        kind: "text",
        text: "subagent complete",
      }),
      true,
    )

    const completed = await callResponse
    assert.equal(completed.body.id, "task-1")
    assert.equal(completed.body.result.content[0].text, "subagent complete")
    assert.equal(getPendingProxyCalls(brokerSession).length, 0)
  } finally {
    server.calls.off("call", forwardCall)
    rejectAllPendingProxyCallsForSession(brokerSession, new Error("test cleanup"))
    await server.close()
  }
})

test("cleanup rejections classify as notice-level, unknown errors as warn", () => {
  assert.equal(isExpectedCleanupError(SERVER_CLOSED_MESSAGE), true)
  assert.equal(
    isExpectedCleanupError(
      "Proxy tool 'task' timed out after 1800000ms waiting for opencode to resolve the call",
    ),
    true,
  )
  assert.equal(
    isExpectedCleanupError(
      "Pending proxy call 'task' (call-1) was orphaned by a new user turn; rejecting",
    ),
    true,
  )
  assert.equal(
    isExpectedCleanupError(
      "Provider stream was aborted before pending proxy calls were emitted",
    ),
    true,
  )
  assert.equal(isExpectedCleanupError("ECONNRESET"), false)
  assert.equal(isExpectedCleanupError("Unexpected token in JSON"), false)
})

test("closing the server rejects a pending call with the cleanup message", async () => {
  const task = DEFAULT_PROXY_TOOLS.find((tool) => tool.name === "task")
  assert.ok(task)

  const server = await createProxyMcpServer([task])
  const callReceived = new Promise<void>((resolve) => {
    server.calls.once("call", () => resolve())
  })
  const callResponse = postRpc(server.url, {
    jsonrpc: "2.0",
    id: "close-1",
    method: "tools/call",
    params: { name: "task", arguments: TASK_INPUT },
  })
  await callReceived
  await server.close()

  const rejected = await callResponse
  assert.equal(rejected.body.id, "close-1")
  // tools/call failures are MCP results with isError, never JSON-RPC error
  // envelopes (Claude CLI rejects those as schema-invalid).
  assert.equal(rejected.body.result.isError, true)
  assert.equal(rejected.body.result.content[0].text, SERVER_CLOSED_MESSAGE)
  assert.equal(isExpectedCleanupError(rejected.body.result.content[0].text), true)
})

test("parallel proxy calls preserve success and error correlation", async () => {
  const task = DEFAULT_PROXY_TOOLS.find((tool) => tool.name === "task")
  assert.ok(task)

  const brokerSession = `proxy-batch-${Date.now()}`
  const server = await createProxyMcpServer([task])
  const forwardCall = (call: any) => queuePendingProxyCall(brokerSession, call)
  server.calls.on("call", forwardCall)
  try {
    const inputs = [
      { ...TASK_INPUT, description: "Successful batch call" },
      { ...TASK_INPUT, description: "Tool error batch call" },
      { ...TASK_INPUT, description: "Rejected batch call" },
    ]
    const brokerCalls = waitForBrokerCalls(brokerSession, inputs.length)
    const responses = inputs.map((input, index) =>
      postRpc(server.url, {
        jsonrpc: "2.0",
        id: `batch-${index}`,
        method: "tools/call",
        params: { name: "task", arguments: input },
      }),
    )
    const calls = await brokerCalls
    assert.equal(getPendingProxyCalls(brokerSession).length, inputs.length)

    const byDescription = new Map(
      calls.map((call) => [call.input.description, call]),
    )
    for (const input of inputs) {
      assert.deepEqual(byDescription.get(input.description)?.input, input)
    }
    const successful = byDescription.get("Successful batch call")!
    const toolError = byDescription.get("Tool error batch call")!
    const rejected = byDescription.get("Rejected batch call")!

    rejectPendingProxyCallById(
      rejected.toolCallId,
      new Error("broker call rejecting as orphaned by test"),
    )
    resolvePendingProxyCallById(successful.toolCallId, {
      kind: "text",
      text: "batch complete",
    })
    resolvePendingProxyCallById(toolError.toolCallId, {
      kind: "error",
      message: "subagent failed",
    })

    const [successResponse, toolErrorResponse, rejectedResponse] =
      await Promise.all(responses)
    assert.equal(successResponse.body.id, "batch-0")
    assert.equal(successResponse.body.result.content[0].text, "batch complete")
    assert.equal(toolErrorResponse.body.id, "batch-1")
    assert.equal(toolErrorResponse.body.result.isError, true)
    assert.equal(
      toolErrorResponse.body.result.content[0].text,
      "subagent failed",
    )
    assert.equal(rejectedResponse.body.id, "batch-2")
    assert.equal(rejectedResponse.body.result.isError, true)
    assert.equal(
      rejectedResponse.body.result.content[0].text,
      "broker call rejecting as orphaned by test",
    )
    assert.equal(getPendingProxyCalls(brokerSession).length, 0)
  } finally {
    server.calls.off("call", forwardCall)
    rejectAllPendingProxyCallsForSession(brokerSession, new Error("test cleanup"))
    await server.close()
  }
})

test("normal text plus Task result closes on native tool boundary", async () => {
  const result = await streamTaskBoundary("normal")
  assertNativeTaskBoundary(result.parts, result.pending)
})

test("non-partial parallel Task calls share one native tool boundary", async () => {
  const result = await streamTaskBoundary("nonpartial-batch")
  assertNativeTaskBoundary(result.parts, result.pending, [
    TASK_INPUT,
    PARALLEL_TASK_INPUT,
  ])
})

test("result before delayed Task call still closes on native tool boundary", async () => {
  const result = await streamTaskBoundary("race")
  assertNativeTaskBoundary(result.parts, result.pending)
})

test("parallel Task calls drain in one native tool boundary", async () => {
  const result = await streamTaskBoundary("batch")
  assertNativeTaskBoundary(result.parts, result.pending, [
    TASK_INPUT,
    PARALLEL_TASK_INPUT,
  ])
})

test("a proxy call surfaces before Claude emits message_stop", async () => {
  const result = await streamTaskBoundary("delayed-message-stop")
  assertNativeTaskBoundary(result.parts, result.pending, [TASK_INPUT])
  assert.equal(result.messageStopEmitted, false)
})

test("a proxy call arriving after stream close surfaces on the tool-result turn", {
  timeout: 10_000,
}, async () => {
  const fake = createFakeTaskCli("late-independent-call")
  const modelId = "claude-test-task-late-independent-call"
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default`)
  const brokerCalls = waitForBrokerCalls(sk, 2)

  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Task"],
    }).languageModel(modelId)
    const tools = [
      {
        type: "function",
        name: "task",
        description: "Delegate work to an opencode subagent",
        inputSchema: { type: "object", properties: {} },
      },
    ]
    const firstPrompt = [
      {
        role: "user",
        content: [{ type: "text", text: "Delegate both provider checks." }],
      },
    ]
    const firstResponse = await model.doStream({
      prompt: firstPrompt,
      tools,
    } as any)
    const firstParts: any[] = []
    for await (const part of firstResponse.stream) firstParts.push(part)
    const firstCall = firstParts.find(
      (part) => part.type === "tool-call" && part.toolName === "task",
    )
    assert.ok(firstCall)
    assert.deepEqual(JSON.parse(firstCall.input), TASK_INPUT)

    await brokerCalls
    assert.equal(getPendingProxyCalls(sk).length, 2)

    const secondResponse = await model.doStream({
      prompt: [
        ...firstPrompt,
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: firstCall.toolCallId,
              toolName: "task",
              input: firstCall.input,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: firstCall.toolCallId,
              toolName: "task",
              output: { type: "text", value: "first subagent complete" },
            },
          ],
        },
      ],
      tools,
    } as any)
    const secondParts: any[] = []
    let replayTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        (async () => {
          for await (const part of secondResponse.stream) secondParts.push(part)
        })(),
        new Promise((_, reject) => {
          replayTimeout = setTimeout(
            () => reject(new Error("late proxy call was not surfaced")),
            2_000,
          )
        }),
      ])
    } finally {
      if (replayTimeout) clearTimeout(replayTimeout)
    }

    const replayedCalls = secondParts.filter(
      (part) => part.type === "tool-call" && part.toolName === "task",
    )
    assert.equal(replayedCalls.length, 1)
    assert.deepEqual(JSON.parse(replayedCalls[0].input), PARALLEL_TASK_INPUT)
    assert.equal(replayedCalls[0].providerExecuted, false)
    const finishes = secondParts.filter((part) => part.type === "finish")
    assert.equal(finishes.length, 1)
    assert.equal(finishes[0].finishReason.unified, "tool-calls")
    assert.deepEqual(
      getPendingProxyCalls(sk).map((call) => call.input),
      [PARALLEL_TASK_INPUT],
    )
  } finally {
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a missing parallel MCP call does not block the calls that arrived", async () => {
  const result = await streamTaskBoundary("missing-batch-call")
  assertNativeTaskBoundary(result.parts, result.pending, [TASK_INPUT])
})

test("duplicate Claude results still produce one native Task completion", async () => {
  const result = await streamTaskBoundary("duplicate")
  assertNativeTaskBoundary(result.parts, result.pending)
})

test("error result does not wait for a missing proxy call", async () => {
  const result = await streamTaskBoundary("error")
  assert.equal(result.pending.length, 0)
  assert.equal(
    result.parts.filter((part) => part.type === "tool-call").length,
    0,
  )
  const finishes = result.parts.filter((part) => part.type === "finish")
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0].finishReason.unified, "stop")
})

test("immediate abort rejects a buffered Task call", async () => {
  const fake = createFakeTaskCli("abort")
  const modelId = "claude-test-task-abort"
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default`)
  const abortController = new AbortController()
  const brokerCalls = waitForBrokerCalls(sk, 1)

  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Task"],
    }).languageModel(modelId)
    const response = await model.doStream({
      abortSignal: abortController.signal,
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "Delegate without narration." }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "task",
          description: "Delegate work to an opencode subagent",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    } as any)
    const partsPromise = (async () => {
      const parts: any[] = []
      for await (const part of response.stream) parts.push(part)
      return parts
    })()

    await brokerCalls
    assert.equal(getPendingProxyCalls(sk).length, 1)
    abortController.abort()

    const parts = await partsPromise
    assert.equal(
      parts.filter((part) => part.type === "tool-call").length,
      0,
    )
    assert.equal(getPendingProxyCalls(sk).length, 0)
  } finally {
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("parent tool-result turn defers MCP hot reload and continues the same Claude process", {
  timeout: 10_000,
}, async () => {
  const fake = createFakeTaskCli("followup")
  const modelId = "claude-test-task-followup"
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default`)
  const configPath = join(fake.cwd, "opencode.json")

  mkdirSync(join(fake.cwd, ".git"))
  writeFileSync(
    configPath,
    JSON.stringify({
      mcp: {
        changing: {
          type: "local",
          command: ["node", "first-server.cjs"],
        },
      },
    }),
  )

  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: true,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Task"],
    }).languageModel(modelId)
    const tools = [
      {
        type: "function",
        name: "task",
        description: "Delegate work to an opencode subagent",
        inputSchema: { type: "object", properties: {} },
      },
    ]
    const firstPrompt = [
      {
        role: "user",
        content: [{ type: "text", text: "Delegate the focused provider check." }],
      },
    ]
    const firstResponse = await model.doStream({
      prompt: firstPrompt,
      tools,
    } as any)
    const firstParts: any[] = []
    for await (const part of firstResponse.stream) firstParts.push(part)

    const taskCall = firstParts.find(
      (part) => part.type === "tool-call" && part.toolName === "task",
    )
    assert.ok(taskCall)
    assert.equal(taskCall.providerExecuted, false)
    assert.equal(getPendingProxyCalls(sk).length, 1)

    let unmatchedRejected = false
    const unmatchedToolCallId = "parallel-task-still-running"
    queuePendingProxyCall(sk, {
      id: unmatchedToolCallId,
      toolName: "task",
      input: {
        description: "Parallel sibling",
        prompt: "Keep running until a later tool-result turn.",
        subagent_type: "explore",
      },
      resolve() {},
      reject() {
        unmatchedRejected = true
      },
    })
    assert.equal(getPendingProxyCalls(sk).length, 2)

    writeFileSync(
      configPath,
      JSON.stringify({
        mcp: {
          changing: {
            type: "local",
            command: ["node", "second-server.cjs"],
          },
        },
      }),
    )

    const secondResponse = await model.doStream({
      prompt: [
        ...firstPrompt,
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: taskCall.toolCallId,
              toolName: "task",
              input: taskCall.input,
            },
            {
              type: "tool-call",
              toolCallId: unmatchedToolCallId,
              toolName: "task",
              input: JSON.stringify({
                description: "Parallel sibling",
                prompt: "Keep running until a later tool-result turn.",
                subagent_type: "explore",
              }),
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: taskCall.toolCallId,
              toolName: "task",
              output: { type: "text", value: "subagent complete" },
            },
          ],
        },
      ],
      tools,
    } as any)
    const secondParts: any[] = []
    for await (const part of secondResponse.stream) secondParts.push(part)

    const continuationText = secondParts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
    assert.equal(continuationText, "Parent received: subagent complete")
    const finishes = secondParts.filter((part) => part.type === "finish")
    assert.equal(finishes.length, 1)
    assert.equal(finishes[0].finishReason.unified, "stop")
    assert.equal(unmatchedRejected, false)
    assert.deepEqual(
      getPendingProxyCalls(sk).map((call) => call.toolCallId),
      [unmatchedToolCallId],
    )
  } finally {
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("task_batch fans one Claude MCP call into concurrent opencode tasks", {
  timeout: 10_000,
}, async () => {
  const fake = createFakeTaskCli("task-batch-followup")
  const modelId = "claude-test-task-batch-followup"
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default`)

  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Task"],
    }).languageModel(modelId)
    const tools = [
      {
        type: "function",
        name: "task",
        description: "Delegate work to an opencode subagent",
        inputSchema: { type: "object", properties: {} },
      },
    ]
    const firstPrompt = [
      {
        role: "user",
        content: [{ type: "text", text: "Delegate both checks concurrently." }],
      },
    ]
    const firstResponse = await model.doStream({
      prompt: firstPrompt,
      tools,
    } as any)
    const firstParts: any[] = []
    for await (const part of firstResponse.stream) firstParts.push(part)

    const taskCalls = firstParts.filter(
      (part) => part.type === "tool-call" && part.toolName === "task",
    )
    assert.equal(taskCalls.length, 2)
    assert.deepEqual(
      taskCalls.map((call) => JSON.parse(call.input)),
      TASK_BATCH_INPUT.tasks,
    )
    assert.match(taskCalls[0].toolCallId, /_task_0$/)
    assert.match(taskCalls[1].toolCallId, /_task_1$/)
    for (const call of taskCalls) {
      assert.match(call.toolCallId, /^[A-Za-z0-9_-]+$/)
    }

    const pending = getPendingProxyCalls(sk)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].toolName, TASK_BATCH_TOOL_NAME)
    assert.deepEqual(pending[0].input, TASK_BATCH_INPUT)

    const childOutputs = ["first subagent complete", "second subagent failed"]
    const secondResponse = await model.doStream({
      prompt: [
        ...firstPrompt,
        {
          role: "assistant",
          content: taskCalls.map((call) => ({
            type: "tool-call",
            toolCallId: call.toolCallId,
            toolName: "task",
            input: call.input,
          })),
        },
        {
          role: "tool",
          content: taskCalls.map((call, index) => ({
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: "task",
            output: {
              type: index === 0 ? "text" : "error-text",
              value: childOutputs[index],
            },
          })),
        },
      ],
      tools,
    } as any)
    const secondParts: any[] = []
    for await (const part of secondResponse.stream) secondParts.push(part)

    const continuationText = secondParts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
    assert.match(continuationText, /^Batch parent received: /)
    const aggregate = JSON.parse(
      continuationText.slice("Batch parent received: ".length),
    )
    assert.deepEqual(
      aggregate.results.map((result: any) => result.output),
      childOutputs,
    )
    assert.deepEqual(
      aggregate.results.map((result: any) => result.description),
      TASK_BATCH_INPUT.tasks.map((task) => task.description),
    )
    assert.deepEqual(
      aggregate.results.map((result: any) => result.isError),
      [false, true],
    )
    assert.equal(getPendingProxyCalls(sk).length, 0)
  } finally {
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("task_batch reports a partial child-result turn instead of orphaning", {
  timeout: 10_000,
}, async () => {
  const fake = createFakeTaskCli("task-batch-followup")
  const modelId = "claude-test-task-batch-partial"
  const sk = sessionKey(fake.cwd, `${modelId}::tools::default`)

  try {
    const model = createClaudeCode({
      cliPath: fake.cliPath,
      cwd: fake.cwd,
      bridgeOpencodeMcp: false,
      proxyOpencodeMcpTools: false,
      proxyTools: ["Task"],
    }).languageModel(modelId)
    const tools = [{
      type: "function",
      name: "task",
      description: "Delegate work to an opencode subagent",
      inputSchema: { type: "object", properties: {} },
    }]
    const firstPrompt = [{
      role: "user",
      content: [{ type: "text", text: "Delegate both checks concurrently." }],
    }]
    const firstResponse = await model.doStream({ prompt: firstPrompt, tools } as any)
    const firstParts: any[] = []
    for await (const part of firstResponse.stream) firstParts.push(part)
    const taskCalls = firstParts.filter(
      (part) => part.type === "tool-call" && part.toolName === "task",
    )
    assert.equal(taskCalls.length, 2)

    const secondResponse = await model.doStream({
      prompt: [
        ...firstPrompt,
        {
          role: "assistant",
          content: taskCalls.map((call) => ({
            type: "tool-call",
            toolCallId: call.toolCallId,
            toolName: "task",
            input: call.input,
          })),
        },
        {
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: taskCalls[0].toolCallId,
            toolName: "task",
            output: { type: "text", value: "only first result arrived" },
          }],
        },
      ],
      tools,
    } as any)
    const secondParts: any[] = []
    for await (const part of secondResponse.stream) secondParts.push(part)
    const continuationText = secondParts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")

    assert.match(continuationText, /received 1 of 2 child results/)
    assert.equal(getPendingProxyCalls(sk).length, 0)
  } finally {
    rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
    deleteActiveProcess(sk)
    rmSync(fake.cwd, { recursive: true, force: true })
  }
})

test("a long-running proxy call flushes headers before it resolves", async () => {
  // undici (Node's fetch, and the Claude CLI's MCP client) aborts a request
  // that has not produced response headers within 300s — incompatible with
  // an unlimited `task` subagent. The server must therefore
  // commit headers as soon as the call is registered, not when it finishes.
  const task = DEFAULT_PROXY_TOOLS.find((tool) => tool.name === "task")
  assert.ok(task)

  const server = await createProxyMcpServer([task])
  try {
    let pendingCall: any = null
    const callReceived = new Promise<void>((resolve) => {
      server.calls.once("call", (entry: any) => {
        pendingCall = entry
        resolve()
      })
    })

    const url = new URL(server.url)
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: "longpoll-1",
      method: "tools/call",
      params: { name: "task", arguments: TASK_INPUT },
    })

    const { request } = await import("node:http")
    const headers = await new Promise<any>((resolve, reject) => {
      const req = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (res) => resolve(res),
      )
      req.on("error", reject)
      req.end(payload)
    })

    await callReceived
    assert.ok(pendingCall, "server should have emitted the call")

    // Headers are in hand while the call is still unresolved — that is the
    // whole point. Chunked encoding (no content-length) is what lets the
    // heartbeat dribble keepalive bytes until the result is ready.
    assert.equal(headers.statusCode, 200)
    assert.equal(headers.headers["content-length"], undefined)
    assert.equal(headers.headers["transfer-encoding"], "chunked")

    // Resolving late must still produce a parseable body, even though
    // keepalive whitespace may already precede it on the wire.
    pendingCall.resolve({ kind: "text", text: "late but fine" })

    const body = await new Promise<string>((resolve, reject) => {
      let acc = ""
      headers.setEncoding("utf8")
      headers.on("data", (c: string) => (acc += c))
      headers.on("end", () => resolve(acc))
      headers.on("error", reject)
    })

    const parsed = JSON.parse(body)
    assert.equal(parsed.id, "longpoll-1")
    assert.equal(parsed.result.content[0].text, "late but fine")
  } finally {
    await server.close()
  }
})

test("writeJson tolerates a body prefixed with keepalive whitespace", () => {
  // The heartbeat writes spaces before the payload; RFC 8259 says leading
  // whitespace is insignificant, so the client still parses it. Guard the
  // assumption the fix rests on.
  const parsed = JSON.parse('   \n  {"jsonrpc":"2.0","id":1,"result":{"ok":true}}')
  assert.equal(parsed.result.ok, true)
})

test("a Claude CLI that hangs up releases its pending call immediately", async () => {
  // Liveness backstop: without this the call sits until its per-tool deadline
  // even though nobody is listening.
  // Observed via the `cancel` event, because the rejection itself runs on the
  // handler's own promise closure and is invisible from out here.
  const task = DEFAULT_PROXY_TOOLS.find((tool) => tool.name === "task")
  assert.ok(task)

  const server = await createProxyMcpServer([task])
  try {
    const cancelled = new Promise<{ id: string; toolName: string }>((resolve) => {
      server.calls.once("cancel", resolve)
    })
    const registered = new Promise<any>((resolve) => {
      server.calls.once("call", resolve)
    })

    const url = new URL(server.url)
    const { request } = await import("node:http")
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: { "content-type": "application/json" },
    })
    req.on("error", () => {})
    req.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "gone-1",
        method: "tools/call",
        params: { name: "task", arguments: TASK_INPUT },
      }),
    )

    const entry = await registered
    req.destroy()

    const event = await cancelled
    assert.equal(event.id, entry.id)
    assert.equal(event.toolName, "task")
    assert.equal(
      isExpectedCleanupError(`${CLIENT_GONE_MESSAGE}: task`),
      true,
      "cleanup rejection should log at notice, not warn",
    )
  } finally {
    await server.close()
  }
})
