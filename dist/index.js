// src/claude-code-language-model.ts
import { generateId } from "@ai-sdk/provider-utils";

// src/logger.ts
import { appendFileSync, mkdirSync, renameSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
var LEVEL_RANK = {
  debug: 0,
  info: 1,
  notice: 2,
  warn: 3,
  error: 4
};
var MAX_LOG_BYTES = 5 * 1024 * 1024;
var DEFAULT_DIR = join(homedir(), ".local", "share", "opencode-claude-code");
var DEFAULT_CONFIG = {
  file: false,
  dir: null,
  mode: "silent",
  level: "info"
};
function parseBoolEnv(v) {
  if (v == null) return void 0;
  const s = v.toLowerCase().trim();
  if (s === "") return void 0;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return true;
}
function parseLevelEnv(v) {
  if (v == null) return void 0;
  const s = v.toLowerCase().trim();
  if (s === "") return void 0;
  if (s === "debug" || s === "info" || s === "notice" || s === "warn" || s === "error") {
    return s;
  }
  return void 0;
}
function parseModeFromDebugEnv(v) {
  if (v == null || v === "") return void 0;
  return v.includes("opencode-claude-code") ? "debug" : void 0;
}
function withEnvOverrides(base) {
  const result = { ...base };
  const envFile = parseBoolEnv(process.env.OPENCODE_CLAUDE_CODE_LOG_FILE);
  if (envFile !== void 0) result.file = envFile;
  const envDir = process.env.OPENCODE_CLAUDE_CODE_LOG_DIR;
  if (envDir !== void 0 && envDir !== "") result.dir = envDir;
  const envMode = parseModeFromDebugEnv(process.env.DEBUG);
  if (envMode !== void 0) result.mode = envMode;
  const envLevel = parseLevelEnv(process.env.OPENCODE_CLAUDE_CODE_LOG_LEVEL);
  if (envLevel !== void 0) result.level = envLevel;
  return result;
}
var activeConfig = withEnvOverrides(DEFAULT_CONFIG);
var fileLoggingDisabled = false;
function configureLogger(input) {
  const merged = { ...DEFAULT_CONFIG, ...input };
  activeConfig = withEnvOverrides(merged);
  fileLoggingDisabled = false;
}
function resolvedLogFile() {
  return join(activeConfig.dir ?? DEFAULT_DIR, "plugin.log");
}
function rotateIfNeeded(logFile) {
  try {
    const stat = statSync(logFile);
    if (stat.size > MAX_LOG_BYTES) {
      renameSync(logFile, `${logFile}.1`);
    }
  } catch {
  }
}
function writeToFile(line) {
  if (!activeConfig.file) return;
  if (fileLoggingDisabled) return;
  try {
    const logFile = resolvedLogFile();
    mkdirSync(dirname(logFile), { recursive: true });
    rotateIfNeeded(logFile);
    appendFileSync(logFile, line + "\n", "utf8");
  } catch {
    fileLoggingDisabled = true;
  }
}
function fmt(level, msg, data) {
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const base = `[${ts}] [opencode-claude-code] ${level}: ${msg}`;
  if (data && Object.keys(data).length > 0) {
    return `${base} ${JSON.stringify(data)}`;
  }
  return base;
}
function shouldEmit(level) {
  return LEVEL_RANK[level] >= LEVEL_RANK[activeConfig.level];
}
function shouldTui(level) {
  if (level === "warn" || level === "error") return true;
  return activeConfig.mode === "debug";
}
function emit(level, msg, data) {
  if (!shouldEmit(level)) return;
  const line = fmt(level.toUpperCase(), msg, data);
  if (shouldTui(level)) {
    console.error(line);
  }
  writeToFile(line);
}
var log = {
  debug(msg, data) {
    emit("debug", msg, data);
  },
  info(msg, data) {
    emit("info", msg, data);
  },
  notice(msg, data) {
    emit("notice", msg, data);
  },
  warn(msg, data) {
    emit("warn", msg, data);
  },
  error(msg, data) {
    emit("error", msg, data);
  }
};

// src/todo-ledger.ts
var ledgers = /* @__PURE__ */ new Map();
var PENDING_CREATE_TTL_MS = 6e4;
var TASK_CREATED_PATTERN = /Task\s*#?\s*(\d+)\s+created/i;
var VALID_STATUSES = /* @__PURE__ */ new Set(["pending", "in_progress", "completed"]);
function getOrCreate(sessionId) {
  let ledger = ledgers.get(sessionId);
  if (!ledger) {
    ledger = { todos: /* @__PURE__ */ new Map(), pendingCreates: /* @__PURE__ */ new Map() };
    ledgers.set(sessionId, ledger);
  }
  return ledger;
}
function prunePending(ledger) {
  const cutoff = Date.now() - PENDING_CREATE_TTL_MS;
  for (const [id, pending] of ledger.pendingCreates) {
    if (pending.createdAt < cutoff) ledger.pendingCreates.delete(id);
  }
}
function materialize(ledger) {
  return Array.from(ledger.todos.values());
}
function resolveSubject(input) {
  const subject = typeof input?.subject === "string" ? input.subject.trim() : "";
  if (subject) return subject;
  const description = typeof input?.description === "string" ? input.description.trim() : "";
  if (description) return description;
  return "(no subject)";
}
function applyTaskCreateToolUse(sessionId, toolUseId, input) {
  if (!sessionId || !toolUseId) return;
  const ledger = getOrCreate(sessionId);
  prunePending(ledger);
  ledger.pendingCreates.set(toolUseId, {
    subject: resolveSubject(input),
    createdAt: Date.now()
  });
}
function applyTaskCreateToolResult(sessionId, toolUseId, resultText) {
  if (!sessionId || !toolUseId) return null;
  const ledger = ledgers.get(sessionId);
  if (!ledger) return null;
  const pending = ledger.pendingCreates.get(toolUseId);
  if (!pending) return null;
  ledger.pendingCreates.delete(toolUseId);
  const match = typeof resultText === "string" ? resultText.match(TASK_CREATED_PATTERN) : null;
  if (!match) {
    log.debug("TaskCreate result did not match expected format", { sessionId, toolUseId, resultText });
    return null;
  }
  const claudeId = match[1];
  if (ledger.todos.has(claudeId)) {
    log.debug("TaskCreate result for already-known claude id; overwriting", { sessionId, claudeId });
  }
  ledger.todos.set(claudeId, { id: claudeId, content: pending.subject, status: "pending" });
  return materialize(ledger);
}
function applyTaskUpdate(sessionId, input) {
  if (!sessionId) return null;
  const taskId = typeof input?.taskId === "string" ? input.taskId : null;
  if (!taskId) return null;
  const ledger = ledgers.get(sessionId);
  if (!ledger) return null;
  const entry = ledger.todos.get(taskId);
  if (!entry) {
    log.debug("TaskUpdate for unknown task id", { sessionId, taskId });
    return null;
  }
  if (input?.status === "deleted") {
    ledger.todos.delete(taskId);
    return materialize(ledger);
  }
  if (typeof input?.status === "string" && VALID_STATUSES.has(input.status)) {
    entry.status = input.status;
  }
  if (typeof input?.subject === "string" && input.subject.trim().length > 0) {
    entry.content = input.subject.trim();
  }
  return materialize(ledger);
}
function clearLedger(sessionId) {
  if (!sessionId) return;
  ledgers.delete(sessionId);
}

// src/tool-mapping.ts
function isWebSearchTool(name) {
  return name === "WebSearch" || name === "web_search";
}
function isWebSearchHandledByCli(route) {
  return !route || route === "claude" || route === "disabled";
}
function mapToolInput(name, input) {
  if (!input) return input;
  switch (name) {
    case "Write":
      return {
        filePath: input.file_path ?? input.filePath,
        content: input.content
      };
    case "Edit":
      return {
        filePath: input.file_path ?? input.filePath,
        oldString: input.old_string ?? input.oldString,
        newString: input.new_string ?? input.newString,
        replaceAll: input.replace_all ?? input.replaceAll
      };
    case "Read":
      return {
        filePath: input.file_path ?? input.filePath,
        offset: input.offset,
        limit: input.limit
      };
    case "Bash":
      return {
        command: input.command,
        description: input.description || `Execute: ${String(input.command || "").slice(0, 50)}${String(input.command || "").length > 50 ? "..." : ""}`,
        timeout: input.timeout
      };
    case "NotebookEdit":
      return {
        notebookPath: input.notebook_path ?? input.notebookPath,
        cellNumber: input.cell_number ?? input.cellNumber,
        newSource: input.new_source ?? input.newSource,
        cellType: input.cell_type ?? input.cellType,
        editMode: input.edit_mode ?? input.editMode
      };
    case "Glob":
      return {
        pattern: input.pattern,
        path: input.path
      };
    case "Grep":
      return {
        pattern: input.pattern,
        path: input.path,
        include: input.include
      };
    case "TodoWrite":
      if (Array.isArray(input.todos)) {
        const mappedTodos = input.todos.map((todo, index) => ({
          content: todo.content,
          status: todo.status || "pending",
          priority: todo.priority || "medium",
          id: todo.id || `todo_${Date.now()}_${index}`
        }));
        return { todos: mappedTodos };
      }
      return input;
    default:
      return input;
  }
}
var OPENCODE_HANDLED_TOOLS = /* @__PURE__ */ new Set([
  "Edit",
  "Write",
  "Bash",
  "NotebookEdit",
  "Read",
  "Glob",
  "Grep"
]);
var CLAUDE_INTERNAL_TOOLS = /* @__PURE__ */ new Set([
  "ToolSearch",
  "Agent",
  "AskFollowupQuestion",
  "TaskList",
  "TaskGet",
  "TaskStop"
]);
function emitTodoWrite(todos) {
  return {
    name: "todowrite",
    input: {
      todos: todos.map((todo) => ({
        id: todo.id,
        content: todo.content,
        status: todo.status,
        priority: "medium"
      }))
    },
    executed: false
  };
}
function mapTool(name, input, opts) {
  if (CLAUDE_INTERNAL_TOOLS.has(name)) {
    log.debug("skipping Claude CLI internal tool", { name });
    return { name, input, executed: true, skip: true };
  }
  if (name === "TaskCreate") {
    if (opts?.sessionId && opts?.toolUseId) {
      applyTaskCreateToolUse(opts.sessionId, opts.toolUseId, input);
    }
    return { name, input, executed: true, skip: true };
  }
  if (name === "TaskUpdate") {
    if (opts?.sessionId) {
      const list = applyTaskUpdate(opts.sessionId, input);
      if (list !== null) return emitTodoWrite(list);
    }
    return { name, input, executed: true, skip: true };
  }
  if (name === "EnterPlanMode") return { name: "plan_enter", input: {}, executed: false };
  if (name === "ExitPlanMode") return { name: "plan_exit", input, executed: false };
  if (name === "TodoWrite") {
    const mappedInput = mapToolInput(name, input);
    return { name: "todowrite", input: mappedInput, executed: false };
  }
  if (isWebSearchTool(name)) {
    const mappedInput = input?.query ? { query: input.query } : input;
    const route = opts?.webSearch;
    if (route && route !== "claude" && route !== "disabled") {
      log.debug("routing WebSearch to opencode tool", { target: route, mappedInput });
      return { name: route, input: mappedInput, executed: false };
    }
    log.debug("WebSearch executed by Claude CLI", { mappedInput });
    return { name: "WebSearch", input: mappedInput, executed: true, skip: true };
  }
  if (name === "TaskOutput") {
    if (!input) return { name: "bash", executed: false };
    const output = input?.content || input?.output || JSON.stringify(input);
    return {
      name: "bash",
      input: {
        command: `echo "TASK OUTPUT: ${String(output).replace(/"/g, '\\"')}"`,
        description: "Displaying task output"
      },
      executed: false
    };
  }
  if (name.startsWith("mcp__")) {
    const parts = name.slice(5).split("__");
    if (parts.length >= 2) {
      const serverName = parts[0];
      const toolName = parts.slice(1).join("_");
      const openCodeName = `${serverName}_${toolName}`;
      log.debug("mapping MCP tool", { original: name, mapped: openCodeName });
      return { name: openCodeName, input, executed: true };
    }
  }
  if (OPENCODE_HANDLED_TOOLS.has(name)) {
    const mappedInput = mapToolInput(name, input);
    const openCodeName = name.toLowerCase();
    log.debug("mapping CLI-executed tool", { name, openCodeName });
    return { name: openCodeName, input: mappedInput, executed: true };
  }
  return { name, input, executed: true };
}

// src/message-builder.ts
var THINKING_KEYWORDS = {
  minimal: null,
  low: "think",
  medium: "think hard",
  high: "think harder",
  xhigh: "megathink",
  max: "ultrathink"
};
function reasoningKeyword(effort) {
  if (!effort) return null;
  return THINKING_KEYWORDS[effort] ?? null;
}
var SUPPORTED_IMAGE_TYPES = /* @__PURE__ */ new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
]);
function toImageBlock(part) {
  const raw = part.data ?? part.url ?? part.source?.data;
  if (!raw) {
    log.warn("file part without data, skipping");
    return null;
  }
  let resolvedMediaType = part.mediaType || part.mimeType || part.mime || "";
  let base64 = null;
  if (typeof raw === "string") {
    if (raw.startsWith("data:")) {
      const match = /^data:([^;,]+)(?:;[^,]*)*(?:;base64)?,(.*)$/s.exec(raw);
      if (!match) {
        log.warn("malformed data URI, skipping file part");
        return null;
      }
      resolvedMediaType = resolvedMediaType || match[1];
      base64 = match[2];
    } else if (/^https?:\/\//i.test(raw)) {
      log.warn("remote URL images are not supported by Claude CLI, skipping");
      return null;
    } else {
      base64 = raw;
    }
  } else if (raw instanceof URL) {
    log.warn("remote URL images are not supported by Claude CLI, skipping");
    return null;
  } else if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
    base64 = Buffer.from(raw).toString("base64");
  } else {
    log.warn("unsupported file part data type", { dataType: typeof raw });
    return null;
  }
  if (!resolvedMediaType || !SUPPORTED_IMAGE_TYPES.has(resolvedMediaType)) {
    log.warn("unsupported media type for Claude image block, skipping", {
      mediaType: resolvedMediaType
    });
    return null;
  }
  return {
    type: "image",
    source: { type: "base64", media_type: resolvedMediaType, data: base64 }
  };
}
function getToolResultText(part) {
  const value = part.output ?? part.result;
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }
  switch (value.type) {
    case "text":
    case "error-text":
      return String(value.value);
    case "json":
    case "error-json":
      return JSON.stringify(value.value);
    case "execution-denied":
      return value.reason ? `Execution denied: ${value.reason}` : "Execution denied";
    case "content":
      return Array.isArray(value.value) ? value.value.map((item) => {
        if (item?.type === "text") return item.text;
        return JSON.stringify(item);
      }).join("\n") : JSON.stringify(value.value);
    default:
      return JSON.stringify(value);
  }
}
var MAX_HISTORY_CHARS = 18e4;
var MAX_TOOL_RESULT_CHARS = 1e4;
var MAX_TOOL_INPUT_CHARS = 2e3;
function clipWithMarker(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}
\u2026[truncated ${text.length - max} chars]`;
}
function renderToolInput(input) {
  let raw;
  try {
    raw = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    raw = String(input);
  }
  return clipWithMarker(raw, MAX_TOOL_INPUT_CHARS);
}
function renderMessageContentForCompaction(msg) {
  const lines = [];
  let toolResultCount = 0;
  if (typeof msg.content === "string") {
    return { text: msg.content, toolResultCount: 0 };
  }
  if (!Array.isArray(msg.content)) {
    return { text: "", toolResultCount: 0 };
  }
  for (const part of msg.content) {
    if (!part) continue;
    switch (part.type) {
      case "text":
        if (part.text) lines.push(part.text);
        break;
      case "tool-call":
        lines.push(
          `[tool_use:${part.toolName ?? "unknown"}(${renderToolInput(part.input)})]`
        );
        break;
      case "tool-result":
        toolResultCount++;
        lines.push(
          `[tool_result:${part.toolName ?? part.toolCallId ?? "unknown"}]
${clipWithMarker(
            getToolResultText(part),
            MAX_TOOL_RESULT_CHARS
          )}`
        );
        break;
      case "image":
        lines.push(
          `[image: ${part.mediaType ?? part.mimeType ?? "unknown"}]`
        );
        break;
      case "file":
        lines.push(
          `[file: ${part.mediaType ?? part.mimeType ?? "unknown"}]`
        );
        break;
      case "reasoning":
        break;
    }
  }
  return { text: lines.join("\n"), toolResultCount };
}
function compactConversationHistory(prompt, opts = {}) {
  const mode = opts.mode ?? "fresh-session";
  if (mode === "compaction") {
    return buildCompactionHistory(prompt);
  }
  const conversationMessages = prompt.filter(
    (m) => m.role === "user" || m.role === "assistant"
  );
  if (conversationMessages.length <= 1) {
    return null;
  }
  const historyParts = [];
  for (let i = 0; i < conversationMessages.length - 1; i++) {
    const msg = conversationMessages[i];
    const role = msg.role === "user" ? "User" : "Assistant";
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter((p) => p.type === "text" && p.text).map((p) => p.text);
      text = textParts.join("\n");
      const toolCalls = msg.content.filter(
        (p) => p.type === "tool-call"
      );
      const toolResults = msg.content.filter(
        (p) => p.type === "tool-result"
      );
      if (toolCalls.length > 0) {
        text += `
[Called ${toolCalls.length} tool(s): ${toolCalls.map((t) => t.toolName).join(", ")}]`;
      }
      if (toolResults.length > 0) {
        text += `
[Received ${toolResults.length} tool result(s)]`;
      }
    }
    if (text.trim()) {
      const truncated = text.length > 2e3 ? text.slice(0, 2e3) + "..." : text;
      historyParts.push(`${role}: ${truncated}`);
    }
  }
  if (historyParts.length === 0) {
    return null;
  }
  return historyParts.join("\n\n");
}
function buildCompactionHistory(prompt) {
  const entries = [];
  let total = 0;
  let totalToolResults = 0;
  let droppedOldest = 0;
  const end = prompt.length > 0 && prompt[prompt.length - 1].role === "user" ? prompt.length - 1 : prompt.length;
  for (let i = end - 1; i >= 0; i--) {
    const msg = prompt[i];
    const roleLabel = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : msg.role === "tool" ? "Tool" : msg.role;
    const { text, toolResultCount } = renderMessageContentForCompaction(msg);
    if (!text.trim()) continue;
    const entry = `${roleLabel}: ${text}`;
    if (total + entry.length > MAX_HISTORY_CHARS) {
      droppedOldest = i + 1;
      break;
    }
    entries.push(entry);
    total += entry.length + 2;
    totalToolResults += toolResultCount;
  }
  if (entries.length === 0) return null;
  entries.reverse();
  log.info("built compaction history", {
    entries: entries.length,
    chars: total,
    toolResults: totalToolResults,
    droppedOldestBefore: droppedOldest
  });
  return entries.join("\n\n");
}
function getClaudeUserMessage(prompt, includeHistoryContext = false, reasoningEffort, opts = {}) {
  const compactionMode = opts.compactionMode === true;
  const content = [];
  if (compactionMode) {
    const transcript = compactConversationHistory(prompt, {
      mode: "compaction"
    });
    if (transcript) {
      log.info("including compaction transcript", {
        historyLength: transcript.length
      });
      content.push({
        type: "text",
        text: `<conversation_transcript>
${transcript}
</conversation_transcript>

The complete prior conversation appears above. The synthesis instructions follow below.

`
      });
    }
  } else if (includeHistoryContext) {
    const historyContext = compactConversationHistory(prompt);
    if (historyContext) {
      log.info("including conversation history context", {
        historyLength: historyContext.length
      });
      content.push({
        type: "text",
        text: `<conversation_history>
The following is a summary of our conversation so far (from a previous session that couldn't be resumed):

${historyContext}

</conversation_history>

Now continuing with the current message:

`
      });
    }
  }
  const messages = [];
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i].role === "assistant") break;
    messages.unshift(prompt[i]);
  }
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        const str = msg.content;
        if (str.trim()) {
          content.push({ type: "text", text: str });
        }
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            if (part.text && part.text.trim()) {
              content.push({ type: "text", text: part.text });
            }
          } else if (part.type === "file" || part.type === "image") {
            const block = toImageBlock(part);
            if (block) {
              content.push(block);
            } else {
              log.debug("skipped non-image file part", {
                mediaType: part.mediaType
              });
            }
          } else if (part.type === "tool-result") {
            const p = part;
            content.push({
              type: "tool_result",
              tool_use_id: p.toolCallId,
              content: getToolResultText(p)
            });
          }
        }
      }
    } else if (msg.role === "tool") {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part?.type === "tool-result") {
            const p = part;
            content.push({
              type: "tool_result",
              tool_use_id: p.toolCallId,
              content: getToolResultText(p)
            });
          }
        }
      }
    }
  }
  if (content.length === 0) {
    log.warn("empty user content; sending sentinel to satisfy CLI");
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "(empty)" }]
      }
    });
  }
  if (!compactionMode) {
    const keyword = reasoningKeyword(reasoningEffort);
    if (keyword) {
      const lastTextPart = [...content].reverse().find((p) => p.type === "text");
      if (lastTextPart) {
        lastTextPart.text = lastTextPart.text ? `${lastTextPart.text}

(${keyword})` : `(${keyword})`;
      } else {
        content.push({ type: "text", text: `(${keyword})` });
      }
      log.debug("injected reasoning keyword", { effort: reasoningEffort, keyword });
    }
  }
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content
    }
  });
}

// src/mcp-bridge.ts
import * as fs2 from "fs";
import * as path2 from "path";
import * as os2 from "os";
import * as crypto from "crypto";
import {
  parse as parseJsonc,
  printParseErrorCode
} from "jsonc-parser";

// src/tmp.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
var PLUGIN_TMP_DIR = path.join(
  os.tmpdir(),
  `opencode-claude-code-${process.pid}`
);
var registered = false;
function pluginTmpDir() {
  if (!fs.existsSync(PLUGIN_TMP_DIR)) {
    fs.mkdirSync(PLUGIN_TMP_DIR, { recursive: true });
  }
  if (!registered) {
    registered = true;
    process.on("exit", () => {
      try {
        fs.rmSync(PLUGIN_TMP_DIR, { recursive: true, force: true });
      } catch {
      }
    });
  }
  return PLUGIN_TMP_DIR;
}

// src/mcp-bridge.ts
var FILE_NAMES = ["opencode.jsonc", "opencode.json", "config.json"];
var PROJECT_FILE_NAMES = ["opencode.json", "opencode.jsonc"];
function fileExists(p) {
  try {
    return fs2.statSync(p).isFile();
  } catch {
    return false;
  }
}
function dirExists(p) {
  try {
    return fs2.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function readAndParse(file) {
  try {
    const raw = fs2.readFileSync(file, "utf8");
    const errors = [];
    const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const first = errors[0];
      throw new Error(
        `${printParseErrorCode(first.error)} at offset ${first.offset}`
      );
    }
    return parsed;
  } catch (e) {
    log.warn("failed to parse opencode config", {
      file,
      error: e instanceof Error ? e.message : String(e)
    });
    return null;
  }
}
function isPlainObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v === void 0) continue;
    const existing = out[k];
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMerge(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
function walkUp(opts) {
  const out = [];
  let current = path2.resolve(opts.start);
  while (true) {
    for (const target of opts.targets) {
      const candidate = path2.join(current, target);
      if (opts.predicate(candidate)) out.push(candidate);
    }
    if (opts.stop && current === path2.resolve(opts.stop)) break;
    const parent = path2.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}
function detectWorktree(cwd) {
  const override = process.env.OPENCODE_WORKTREE;
  if (override) return path2.resolve(override);
  let current = path2.resolve(cwd);
  while (true) {
    const gitPath = path2.join(current, ".git");
    try {
      if (fs2.existsSync(gitPath)) return current;
    } catch {
    }
    const parent = path2.dirname(current);
    if (parent === current) return void 0;
    current = parent;
  }
}
function globalConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME ?? path2.join(os2.homedir(), ".config");
  return path2.join(xdg, "opencode");
}
function loadGlobalConfig() {
  const dir = globalConfigDir();
  let merged = {};
  for (const name of FILE_NAMES.slice().reverse()) {
    const file = path2.join(dir, name);
    if (!fileExists(file)) continue;
    const parsed = readAndParse(file);
    if (parsed) merged = deepMerge(merged, parsed);
  }
  return merged;
}
function loadProjectFilesInDir(dir) {
  let merged = {};
  for (const name of PROJECT_FILE_NAMES) {
    const file = path2.join(dir, name);
    if (!fileExists(file)) continue;
    const parsed = readAndParse(file);
    if (parsed) merged = deepMerge(merged, parsed);
  }
  return merged;
}
function dotOpencodeDirs(cwd, worktree) {
  const dirs = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (p) => {
    const abs = path2.resolve(p);
    if (!seen.has(abs) && dirExists(abs)) {
      seen.add(abs);
      dirs.push(abs);
    }
  };
  for (const dir of walkUp({
    start: cwd,
    stop: worktree,
    targets: [".opencode"],
    predicate: dirExists
  })) {
    push(dir);
  }
  const home = os2.homedir();
  if (home) {
    const homeDot = path2.join(home, ".opencode");
    if (dirExists(homeDot)) push(homeDot);
  }
  const envDir = process.env.OPENCODE_CONFIG_DIR;
  if (envDir && dirExists(envDir)) push(envDir);
  return dirs;
}
function substituteEnvPlaceholders(source) {
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v !== "string") continue;
    out[k] = v.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
      const resolved = process.env[name];
      return typeof resolved === "string" ? resolved : "";
    });
  }
  return out;
}
function translateServer(name, spec) {
  if (spec.enabled === false) return null;
  const type = spec.type;
  if (type === "local") {
    const cmd = spec.command;
    if (!Array.isArray(cmd) || cmd.length === 0) {
      log.warn("skipping local MCP server with no command", { name });
      return null;
    }
    const out = {
      type: "stdio",
      command: String(cmd[0])
    };
    if (cmd.length > 1) out.args = cmd.slice(1).map((s) => String(s));
    if (spec.environment && typeof spec.environment === "object") {
      out.env = substituteEnvPlaceholders(
        spec.environment
      );
    }
    return out;
  }
  if (type === "remote") {
    if (typeof spec.url !== "string" || !spec.url) {
      log.warn("skipping remote MCP server with no url", { name });
      return null;
    }
    const out = {
      type: "http",
      url: spec.url
    };
    if (spec.headers && typeof spec.headers === "object") {
      out.headers = substituteEnvPlaceholders(
        spec.headers
      );
    }
    return out;
  }
  log.warn("skipping MCP server with unknown type", {
    name,
    type: type ?? null
  });
  return null;
}
function extractMcpBlock(config) {
  const mcp = config.mcp;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return {};
  return mcp;
}
function mergeMcp(target, source) {
  const out = { ...target };
  for (const [name, spec] of Object.entries(source)) {
    if (!spec || typeof spec !== "object") continue;
    const existing = out[name];
    if (existing && typeof existing === "object") {
      out[name] = deepMerge(
        existing,
        spec
      );
    } else {
      out[name] = spec;
    }
  }
  return out;
}
function bridgeOpencodeMcp(cwd, runtimeStatus, excludeServers) {
  const {
    servers: merged,
    enabledServerNames: allEnabledServerNames,
    hash
  } = mergeOpencodeMcp(cwd, runtimeStatus);
  const servers = {};
  const bridgedServerNames = [];
  for (const [name, spec] of Object.entries(merged)) {
    if (!spec || typeof spec !== "object") continue;
    if (excludeServers?.has(name)) continue;
    const translated = translateServer(name, spec);
    if (translated) {
      servers[name] = translated;
      bridgedServerNames.push(name);
    }
  }
  return finishBridge({
    servers,
    bridgedServerNames,
    allEnabledServerNames,
    hash,
    excludeServers
  });
}
function mergeOpencodeMcp(cwd, runtimeStatus) {
  const worktree = detectWorktree(cwd);
  let merged = {};
  merged = mergeMcp(merged, extractMcpBlock(loadGlobalConfig()));
  const explicitConfig = process.env.OPENCODE_CONFIG;
  if (explicitConfig && fileExists(explicitConfig)) {
    const parsed = readAndParse(explicitConfig);
    if (parsed) merged = mergeMcp(merged, extractMcpBlock(parsed));
  }
  const projectFiles = walkUp({
    start: cwd,
    stop: worktree,
    targets: PROJECT_FILE_NAMES,
    predicate: fileExists
  });
  const projectDirs = [];
  const seenProjectDirs = /* @__PURE__ */ new Set();
  for (const f of projectFiles) {
    const d = path2.dirname(f);
    if (!seenProjectDirs.has(d)) {
      seenProjectDirs.add(d);
      projectDirs.push(d);
    }
  }
  for (const dir of projectDirs.slice().reverse()) {
    merged = mergeMcp(merged, extractMcpBlock(loadProjectFilesInDir(dir)));
  }
  for (const dir of dotOpencodeDirs(cwd, worktree)) {
    merged = mergeMcp(merged, extractMcpBlock(loadProjectFilesInDir(dir)));
  }
  if (runtimeStatus) {
    for (const name of Object.keys(merged)) {
      const status = runtimeStatus[name];
      if (status === void 0) continue;
      const existing = merged[name];
      const base = existing && typeof existing === "object" ? existing : {};
      merged[name] = { ...base, enabled: status === "connected" };
    }
  }
  const enabledServerNames = [];
  for (const [name, spec] of Object.entries(merged)) {
    if (!spec || typeof spec !== "object") continue;
    const enabled = spec.enabled;
    if (enabled === false) continue;
    enabledServerNames.push(name);
  }
  const mergedBody = JSON.stringify({ mcpServers: merged }, null, 2);
  const hash = crypto.createHash("sha256").update(mergedBody).digest("hex").slice(0, 12);
  return { servers: merged, enabledServerNames, hash };
}
function finishBridge(input) {
  const { servers, bridgedServerNames, allEnabledServerNames, hash, excludeServers } = input;
  if (Object.keys(servers).length === 0) {
    const allEnabledServersExcluded = excludeServers && allEnabledServerNames.length > 0 && allEnabledServerNames.every((name) => excludeServers.has(name));
    if (!allEnabledServersExcluded) return null;
    return {
      path: "",
      hash,
      serverNames: [],
      allEnabledServerNames
    };
  }
  const body = JSON.stringify({ mcpServers: servers }, null, 2);
  const outPath = path2.join(
    pluginTmpDir(),
    `mcp-${hash}.json`
  );
  try {
    if (!fileExists(outPath)) {
      fs2.writeFileSync(outPath, body, { encoding: "utf8", mode: 384 });
    }
  } catch (e) {
    log.warn("failed to write bridged MCP config", {
      error: e instanceof Error ? e.message : String(e)
    });
    return null;
  }
  log.info("bridged opencode MCP config", {
    target: outPath,
    hash,
    servers: bridgedServerNames,
    excluded: excludeServers ? Array.from(excludeServers) : []
  });
  return {
    path: outPath,
    hash,
    serverNames: bridgedServerNames,
    allEnabledServerNames
  };
}

// src/skill-bridge.ts
import * as crypto2 from "crypto";
import * as fs3 from "fs";
import * as os3 from "os";
import * as path3 from "path";

// src/cli-version.ts
import { execFile } from "child_process";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
var cache = /* @__PURE__ */ new Map();
function detectCliVersion(cliPath) {
  const cached = cache.get(cliPath);
  if (cached) return cached;
  const promise = (async () => {
    try {
      const { stdout } = await execFileAsync(cliPath, ["--version"], {
        timeout: 5e3
      });
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout.trim());
      if (!match) {
        log.warn("claude --version output unparseable", { stdout: stdout.trim() });
        return null;
      }
      const v = {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        raw: stdout.trim()
      };
      log.info("detected claude cli version", { cliPath, version: v.raw });
      if (!cliSupportsThinkingDisplay(v)) {
        log.notice(
          "claude cli < 2.1.142 detected; Opus 4.7 thinking summaries unavailable. Run `npm i -g @anthropic-ai/claude-code` to upgrade.",
          { version: v.raw }
        );
      }
      return v;
    } catch (err) {
      log.warn("failed to detect claude cli version", {
        cliPath,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  })();
  cache.set(cliPath, promise);
  return promise;
}
function gte(v, target) {
  if (v.major !== target.major) return v.major > target.major;
  if (v.minor !== target.minor) return v.minor > target.minor;
  return v.patch >= target.patch;
}
function cliSupportsThinkingDisplay(v) {
  if (!v) return false;
  return gte(v, { major: 2, minor: 1, patch: 142 });
}
function cliSupportsThinking(v) {
  if (!v) return false;
  return gte(v, { major: 2, minor: 0, patch: 0 });
}
var flagSupport = /* @__PURE__ */ new Map();
function detectCliSupportsFlag(cliPath, flag) {
  const key = `${cliPath}\0${flag}`;
  const cached = flagSupport.get(key);
  if (cached) return cached;
  const promise = (async () => {
    try {
      const { stdout } = await execFileAsync(cliPath, ["--help"], {
        timeout: 5e3,
        maxBuffer: 4 * 1024 * 1024
      });
      return stdout.includes(flag);
    } catch (err) {
      log.warn("failed to probe claude cli flag support", {
        cliPath,
        flag,
        error: err instanceof Error ? err.message : String(err)
      });
      return false;
    }
  })();
  flagSupport.set(key, promise);
  return promise;
}

// src/skill-bridge.ts
var SKILL_PLUGIN_NAME = "opencode-skills";
function dirExists2(p) {
  try {
    return fs3.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function fileExists2(p) {
  try {
    return fs3.statSync(p).isFile();
  } catch {
    return false;
  }
}
function skillRoots(cwd) {
  const roots = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (p) => {
    const abs = path3.resolve(p);
    if (seen.has(abs)) return;
    seen.add(abs);
    if (dirExists2(abs)) roots.push(abs);
  };
  let current = path3.resolve(cwd);
  while (true) {
    push(path3.join(current, ".opencode", "skills"));
    const parent = path3.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const home = os3.homedir();
  if (home) push(path3.join(home, ".opencode", "skills"));
  const envDir = process.env.OPENCODE_CONFIG_DIR;
  if (envDir) push(path3.join(envDir, "skills"));
  const xdg = process.env.XDG_CONFIG_HOME ?? (home ? path3.join(home, ".config") : null);
  if (xdg) push(path3.join(xdg, "opencode", "skills"));
  return roots;
}
function discoverOpencodeSkills(cwd) {
  const found = [];
  const claimed = /* @__PURE__ */ new Set();
  for (const root of skillRoots(cwd)) {
    let entries;
    try {
      entries = fs3.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const name = entry.name;
      if (name.startsWith(".")) continue;
      if (claimed.has(name)) continue;
      const dir = path3.join(root, name);
      if (!fileExists2(path3.join(dir, "SKILL.md"))) continue;
      claimed.add(name);
      found.push({ name, dir });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
function linkSkill(source, target) {
  try {
    fs3.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    return;
  } catch {
    fs3.cpSync(source, target, { recursive: true, dereference: true });
  }
}
function buildSkillPluginDir(skills) {
  if (skills.length === 0) return null;
  const fingerprint = skills.map((s) => `${s.name}\0${s.dir}`).join("\n");
  const hash = crypto2.createHash("sha256").update(fingerprint).digest("hex").slice(0, 12);
  const root = path3.join(pluginTmpDir(), `skills-${hash}`);
  const manifest = path3.join(root, ".claude-plugin", "plugin.json");
  if (fileExists2(manifest)) return root;
  try {
    fs3.rmSync(root, { recursive: true, force: true });
    fs3.mkdirSync(path3.join(root, ".claude-plugin"), { recursive: true });
    fs3.mkdirSync(path3.join(root, "skills"), { recursive: true });
    fs3.writeFileSync(
      manifest,
      JSON.stringify(
        {
          name: SKILL_PLUGIN_NAME,
          description: "Skills discovered from this opencode installation, bridged into Claude Code."
        },
        null,
        2
      ),
      { encoding: "utf8", mode: 384 }
    );
    for (const skill of skills) {
      linkSkill(skill.dir, path3.join(root, "skills", skill.name));
    }
  } catch (err) {
    log.warn("failed to stage opencode skill plugin dir", {
      root,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
  return root;
}
async function resolveSkillPluginDirs(opts) {
  if (!opts.enabled) return [];
  const skills = discoverOpencodeSkills(opts.cwd);
  if (skills.length === 0) return [];
  const supported = await detectCliSupportsFlag(opts.cliPath, "--plugin-dir");
  if (!supported) {
    log.notice(
      "claude cli does not support --plugin-dir; opencode skills will not be bridged. Run `npm i -g @anthropic-ai/claude-code` to upgrade.",
      { skills: skills.length }
    );
    return [];
  }
  const dir = buildSkillPluginDir(skills);
  if (!dir) return [];
  log.info("bridged opencode skills into claude", {
    count: skills.length,
    names: skills.map((s) => s.name),
    pluginDir: dir
  });
  return [dir];
}

// src/runtime-status.ts
var opencodeClient = null;
function setOpencodeClient(client) {
  if (client && typeof client === "object") {
    opencodeClient = client;
  }
}
var opencodeProjectDirectory;
function setOpencodeProjectDirectory(dir) {
  opencodeProjectDirectory = dir;
}
function getOpencodeProjectDirectory() {
  return opencodeProjectDirectory;
}
function isUsableDirectory(d) {
  return typeof d === "string" && d.length > 1 && d !== "/";
}
function resolveSpawnCwd(configured) {
  return resolveSpawnCwdFrom(
    configured,
    process.cwd(),
    opencodeProjectDirectory
  );
}
function resolveSpawnCwdFrom(configured, live, captured) {
  if (configured) return configured;
  if (isUsableDirectory(live)) return live;
  return captured ?? live;
}
async function getRuntimeMcpStatus() {
  const client = opencodeClient;
  if (!client?.mcp?.status) return void 0;
  try {
    const res = await client.mcp.status();
    const data = res.data;
    if (!data || typeof data !== "object") return void 0;
    const out = {};
    for (const [name, entry] of Object.entries(data)) {
      if (entry && typeof entry === "object") {
        const status = entry.status;
        if (typeof status === "string") out[name] = status;
      }
    }
    return out;
  } catch (err) {
    log.warn("failed to fetch opencode MCP runtime status", {
      error: err instanceof Error ? err.message : String(err)
    });
    return void 0;
  }
}
async function fetchOpencodeToolList(provider, model, directory) {
  const client = opencodeClient;
  if (!client?.tool?.list) return void 0;
  try {
    const res = await client.tool.list({
      query: { provider, model, ...directory ? { directory } : {} }
    });
    const data = res.data;
    if (!Array.isArray(data)) return void 0;
    const out = [];
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry;
      const id = typeof e.id === "string" ? e.id : null;
      const description = typeof e.description === "string" ? e.description : "";
      const parameters = e.parameters && typeof e.parameters === "object" ? e.parameters : {};
      if (!id) continue;
      out.push({ id, description, parameters });
    }
    return out;
  } catch (err) {
    log.warn("failed to fetch opencode tool list", {
      provider,
      model,
      error: err instanceof Error ? err.message : String(err)
    });
    return void 0;
  }
}

// src/session-manager.ts
import { spawn } from "child_process";
import { createInterface } from "readline";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { unlink } from "fs/promises";
var activeProcesses = /* @__PURE__ */ new Map();
var claudeSessions = /* @__PURE__ */ new Map();
var MAX_ACTIVE_PROCESSES = 8;
var IDLE_PROCESS_TTL_MS = 30 * 6e4;
var IDLE_SWEEP_INTERVAL_MS = 5 * 6e4;
var PROCESS_EXIT_TIMEOUT_MS = 1500;
var PROCESS_FORCE_EXIT_TIMEOUT_MS = 500;
var TURN_INTERRUPT_TIMEOUT_MS = 5e3;
function envFlagEnabled(value) {
  if (value === void 0) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return !["0", "false", "no", "off"].includes(normalized);
}
function isClaudeThinkingDisabled() {
  return envFlagEnabled(process.env.CLAUDE_CODE_DISABLE_THINKING) || envFlagEnabled(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING);
}
function claudeSpawnEnv(opts) {
  const env = {
    ...process.env,
    TERM: "xterm-256color"
  };
  if (opts?.ignoreAnthropicApiKey) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  if (!isClaudeThinkingDisabled() && process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES === void 0) {
    env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES = "1";
  }
  return env;
}
var turnTrackers = /* @__PURE__ */ new WeakMap();
function isTerminalResultLine(line) {
  if (!line.includes('"result"')) return false;
  try {
    return JSON.parse(line).type === "result";
  } catch {
    return false;
  }
}
function turnTracker(ap) {
  const existing = turnTrackers.get(ap);
  if (existing) return existing;
  const tracker = { inFlight: false, waiters: [] };
  turnTrackers.set(ap, tracker);
  const settle = () => {
    tracker.inFlight = false;
    for (const wake of tracker.waiters.splice(0)) wake();
  };
  ap.lineEmitter.on("line", (line) => {
    if (!tracker.inFlight) return;
    if (isTerminalResultLine(line)) settle();
  });
  ap.lineEmitter.on("close", settle);
  return tracker;
}
function noteTurnStarted(ap) {
  turnTracker(ap).inFlight = true;
}
function isTurnInFlight(ap) {
  return turnTracker(ap).inFlight;
}
function awaitTurnIdle(ap, timeoutMs) {
  const tracker = turnTracker(ap);
  if (!tracker.inFlight) return Promise.resolve(true);
  return new Promise((resolve5) => {
    const wake = () => {
      clearTimeout(timer);
      resolve5(true);
    };
    const timer = setTimeout(() => {
      const at = tracker.waiters.indexOf(wake);
      if (at >= 0) tracker.waiters.splice(at, 1);
      resolve5(false);
    }, timeoutMs);
    tracker.waiters.push(wake);
  });
}
function interruptTurn(ap, timeoutMs = TURN_INTERRUPT_TIMEOUT_MS) {
  if (!turnTracker(ap).inFlight) return Promise.resolve(true);
  if (ap.interactive) {
    log.notice("interactive transport cannot be interrupted; waiting for turn");
    return awaitTurnIdle(ap, timeoutMs);
  }
  try {
    ap.proc.stdin?.write(
      JSON.stringify({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "interrupt" }
      }) + "\n"
    );
  } catch (error) {
    log.warn("failed to write interrupt control request", {
      error: error instanceof Error ? error.message : String(error)
    });
    return Promise.resolve(false);
  }
  return awaitTurnIdle(ap, timeoutMs);
}
function touch(key) {
  const existing = activeProcesses.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    activeProcesses.delete(key);
    activeProcesses.set(key, existing);
  }
}
function evictIfNeeded() {
  while (activeProcesses.size >= MAX_ACTIVE_PROCESSES) {
    const oldestKey = activeProcesses.keys().next().value;
    if (!oldestKey) break;
    log.info("evicting LRU claude process", { sessionKey: oldestKey });
    deleteActiveProcess(oldestKey);
  }
}
function getActiveProcess(key) {
  const ap = activeProcesses.get(key);
  if (ap) touch(key);
  return ap;
}
function setActiveProcess(key, ap) {
  ap.lastUsedAt = Date.now();
  activeProcesses.set(key, ap);
}
function detachActiveProcess(key) {
  const ap = activeProcesses.get(key);
  if (!ap) return void 0;
  activeProcesses.delete(key);
  void ap.proxyServer?.close();
  return ap;
}
function deleteActiveProcess(key) {
  const ap = detachActiveProcess(key);
  ap?.proc.kill();
}
function hasProcessExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null;
}
function waitForProcessExit(proc, timeoutMs) {
  if (hasProcessExited(proc)) return Promise.resolve(true);
  return new Promise((resolve5) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve5(true);
    };
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      resolve5(hasProcessExited(proc));
    }, timeoutMs);
    proc.once("exit", onExit);
  });
}
async function deleteActiveProcessAndWait(key, options = {}) {
  const ap = detachActiveProcess(key);
  if (!ap || hasProcessExited(ap.proc)) return true;
  const gracefulExit = waitForProcessExit(
    ap.proc,
    options.exitTimeoutMs ?? PROCESS_EXIT_TIMEOUT_MS
  );
  ap.proc.kill();
  if (await gracefulExit) return true;
  const forcedExit = waitForProcessExit(
    ap.proc,
    options.forceExitTimeoutMs ?? PROCESS_FORCE_EXIT_TIMEOUT_MS
  );
  ap.proc.kill("SIGKILL");
  if (await forcedExit) return true;
  log.warn("claude process did not exit; starting a fresh session", {
    sessionKey: key
  });
  deleteClaudeSessionId(key);
  return false;
}
function reapIdleProcesses(ttlMs = IDLE_PROCESS_TTL_MS, now = Date.now()) {
  const reaped = [];
  for (const [key, ap] of [...activeProcesses]) {
    if (isTurnInFlight(ap)) continue;
    if (ap.lastUsedAt === void 0) {
      ap.lastUsedAt = now;
      continue;
    }
    const idleMs = now - ap.lastUsedAt;
    if (idleMs < ttlMs) continue;
    log.info("reaping idle claude process", { sessionKey: key, idleMs });
    void deleteActiveProcessAndWait(key);
    reaped.push(key);
  }
  return reaped;
}
var idleSweepTimer = null;
function startIdleProcessReaper() {
  if (idleSweepTimer) return;
  idleSweepTimer = setInterval(() => {
    reapIdleProcesses();
  }, IDLE_SWEEP_INTERVAL_MS);
  idleSweepTimer.unref?.();
}
function deleteActiveProcessesForAffinity(affinity) {
  if (!affinity || affinity === "default") return [];
  const suffix = `::${affinity}`;
  const released = [];
  for (const key of [...activeProcesses.keys()]) {
    if (!key.endsWith(suffix)) continue;
    log.info("releasing claude process for ended session", { sessionKey: key });
    void deleteActiveProcessAndWait(key);
    deleteClaudeSessionId(key);
    released.push(key);
  }
  return released;
}
function killAllActiveProcesses() {
  for (const key of [...activeProcesses.keys()]) {
    deleteActiveProcess(key);
  }
}
function getClaudeSessionId(key) {
  return claudeSessions.get(key);
}
function setClaudeSessionId(key, sessionId) {
  claudeSessions.set(key, sessionId);
}
function deleteClaudeSessionId(key) {
  const claudeSessionId = claudeSessions.get(key);
  if (claudeSessionId) clearLedger(claudeSessionId);
  claudeSessions.delete(key);
}
function spawnClaudeProcess(cliPath, cliArgs, cwd, sessionKey2, proxyServer, mcpHash, systemPromptFile, ignoreAnthropicApiKey) {
  evictIfNeeded();
  log.info("spawning new claude process", { cliPath, cliArgs, cwd, sessionKey: sessionKey2 });
  const proc = spawn(cliPath, cliArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: claudeSpawnEnv({ ignoreAnthropicApiKey }),
    shell: process.platform === "win32"
  });
  const lineEmitter = new EventEmitter();
  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    lineEmitter.emit("line", line);
  });
  rl.on("close", () => {
    lineEmitter.emit("close");
  });
  const ap = {
    proc,
    lineEmitter,
    proxyServer: proxyServer ?? null,
    mcpHash,
    systemPromptFile,
    lastUsedAt: Date.now()
  };
  activeProcesses.set(sessionKey2, ap);
  proc.on("error", (err) => {
    log.error("claude process error", { sessionKey: sessionKey2, error: err.message });
  });
  proc.on("exit", (code, signal) => {
    log.info("claude process exited", { code, signal, sessionKey: sessionKey2 });
    void proxyServer?.close();
    if (systemPromptFile) {
      void unlink(systemPromptFile).catch(() => {
      });
    }
    const ownsSessionKey = activeProcesses.get(sessionKey2) === ap;
    if (ownsSessionKey) activeProcesses.delete(sessionKey2);
    if (ownsSessionKey && code !== 0 && code !== null) {
      log.info("process exited with error, clearing session", {
        code,
        sessionKey: sessionKey2
      });
      claudeSessions.delete(sessionKey2);
    }
  });
  proc.stderr?.on("data", (data) => {
    const stderr = data.toString();
    log.debug("stderr", { data: stderr.slice(0, 200) });
    if (stderr.includes("No conversation found") || stderr.includes("Session ID") && (stderr.includes("already in use") || stderr.includes("not found") || stderr.includes("invalid"))) {
      if (activeProcesses.get(sessionKey2) === ap) {
        log.warn("claude session ID error, clearing session", {
          sessionKey: sessionKey2,
          error: stderr.slice(0, 200)
        });
        claudeSessions.delete(sessionKey2);
      } else {
        log.debug("ignoring session ID error from stale claude process", {
          sessionKey: sessionKey2
        });
      }
    }
  });
  return ap;
}
function appendResumeIfNeeded(sessionKey2, cliArgs) {
  if (cliArgs.includes("--resume") || cliArgs.includes("--session-id")) {
    return cliArgs;
  }
  const sid = claudeSessions.get(sessionKey2);
  if (!sid) return cliArgs;
  return [...cliArgs, "--resume", sid];
}
function respawnActiveProcess(sessionKey2, cliPath, cliArgs, cwd, ignoreAnthropicApiKey) {
  const old = activeProcesses.get(sessionKey2);
  if (!old) return void 0;
  const turnWasInFlight = isTurnInFlight(old);
  activeProcesses.delete(sessionKey2);
  old.proc.removeAllListeners("exit");
  try {
    old.proc.kill();
  } catch {
  }
  const replacement = spawnClaudeProcess(
    cliPath,
    appendResumeIfNeeded(sessionKey2, cliArgs),
    cwd,
    sessionKey2,
    old.proxyServer,
    old.mcpHash,
    old.systemPromptFile,
    ignoreAnthropicApiKey
  );
  if (turnWasInFlight) noteTurnStarted(replacement);
  return replacement;
}
function buildCliArgs(opts) {
  const {
    sessionKey: sessionKey2,
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
    cliVersion
  } = opts;
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose"
  ];
  if (model) {
    args.push("--model", model);
  }
  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
  }
  if (includeSessionId) {
    const sessionId = claudeSessions.get(sessionKey2);
    if (sessionId && !activeProcesses.has(sessionKey2)) {
      args.push("--resume", sessionId);
    }
  }
  if (mcpConfig) {
    const configs = Array.isArray(mcpConfig) ? mcpConfig : [mcpConfig];
    const filtered = configs.filter((c) => typeof c === "string" && c.length > 0);
    if (filtered.length > 0) {
      args.push("--mcp-config", ...filtered);
    }
  }
  if (strictMcpConfig) {
    args.push("--strict-mcp-config");
  }
  if (pluginDirs && pluginDirs.length > 0) {
    for (const dir of pluginDirs) {
      args.push("--plugin-dir", dir);
    }
  }
  if (disallowedTools && disallowedTools.length > 0) {
    args.push("--disallowedTools", ...disallowedTools);
  }
  if (thinking && cliSupportsThinking(cliVersion ?? null)) {
    args.push("--thinking", thinking);
  }
  if (thinkingDisplay && cliSupportsThinkingDisplay(cliVersion ?? null)) {
    args.push("--thinking-display", thinkingDisplay);
  }
  if (appendSystemPromptFile) {
    args.push("--append-system-prompt-file", appendSystemPromptFile);
  }
  if (skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  return args;
}
function sessionKey(cwd, modelId) {
  return `${cwd}::${modelId}`;
}

// src/claude-session-wrapper.ts
import { EventEmitter as EventEmitter2 } from "events";
import { unlink as unlink2 } from "fs/promises";

// src/claude-session-bun.ts
import * as os4 from "os";
import * as fs4 from "fs";
import * as path4 from "path";
import { execFileSync } from "child_process";
import { randomUUID as randomUUID2 } from "crypto";
function resolveClaude(cmd = "claude") {
  if (path4.isAbsolute(cmd) && fs4.existsSync(cmd)) return cmd;
  const viaBun = Bun.which(cmd);
  if (viaBun) return viaBun;
  const isWin = os4.platform() === "win32";
  try {
    const out = execFileSync(isWin ? "where" : "which", [cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).find((p) => fs4.existsSync(p));
    if (first) return first;
  } catch {
  }
  throw new Error(`Could not resolve command on PATH: ${cmd}`);
}
function encodeCwd(cwd) {
  return path4.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}
var TERMINAL_STOP = /* @__PURE__ */ new Set(["end_turn", "stop_sequence", "max_tokens"]);
var delay = (ms) => new Promise((r) => setTimeout(r, ms));
function resolveConfigDir(configDir) {
  const value = configDir ?? process.env.CLAUDE_CONFIG_DIR;
  if (!value) return path4.join(os4.homedir(), ".claude");
  if (value === "~") return os4.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path4.join(os4.homedir(), value.slice(2));
  }
  return path4.resolve(value);
}
var ClaudeSession = class {
  sessionId;
  cwd;
  configDir;
  jsonlPath;
  raw = "";
  proc = null;
  cursor = 0;
  // index into transcript split('\n')
  lastDataAt = 0;
  exited = false;
  exitCode = null;
  aborted = false;
  signal;
  o;
  constructor(opts = {}) {
    this.cwd = path4.resolve(opts.cwd ?? process.cwd());
    this.configDir = resolveConfigDir(opts.configDir);
    this.signal = opts.signal;
    this.sessionId = randomUUID2();
    this.jsonlPath = path4.join(
      this.configDir,
      "projects",
      encodeCwd(this.cwd),
      `${this.sessionId}.jsonl`
    );
    this.o = {
      cwd: this.cwd,
      cliPath: opts.cliPath,
      configDir: this.configDir,
      model: opts.model,
      settingSources: opts.settingSources,
      extraArgs: opts.extraArgs ?? [],
      ignoreAnthropicApiKey: opts.ignoreAnthropicApiKey,
      cols: opts.cols ?? 200,
      rows: opts.rows ?? 50,
      bootMinMs: opts.bootMinMs ?? 3e3,
      bootQuietMs: opts.bootQuietMs ?? 1500,
      bootMaxMs: opts.bootMaxMs ?? 25e3,
      pollMs: opts.pollMs ?? 250,
      // Agentic turns (tool loops) routinely run for many minutes; a short
      // cap would surface as a mid-task error result. 30 min mirrors the
      // proxy-tool ceiling rather than a chat-reply expectation.
      turnTimeoutMs: opts.turnTimeoutMs ?? 18e5,
      bracketedPaste: opts.bracketedPaste ?? true,
      submitMinMs: opts.submitMinMs ?? 200,
      submitConfirmMs: opts.submitConfirmMs ?? 1500,
      submitMaxRetries: opts.submitMaxRetries ?? 8,
      debug: opts.debug ?? false
    };
  }
  async start() {
    if (this.signal?.aborted) throw new Error("aborted before start");
    this.signal?.addEventListener(
      "abort",
      () => {
        this.aborted = true;
        this.dispose();
      },
      { once: true }
    );
    const claude = resolveClaude(this.o.cliPath ?? "claude");
    const args = ["--session-id", this.sessionId];
    if (this.o.model) args.push("--model", this.o.model);
    if (this.o.settingSources !== null && this.o.settingSources !== void 0) {
      args.push("--setting-sources", this.o.settingSources);
    }
    if (this.o.extraArgs && this.o.extraArgs.length) args.push(...this.o.extraArgs);
    if (this.o.debug)
      process.stderr.write(`[session] spawn: ${claude} ${args.join(" ")}
`);
    this.lastDataAt = Date.now();
    this.proc = Bun.spawn([claude, ...args], {
      cwd: this.cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: this.o.configDir,
        TERM: "xterm-256color",
        ...this.o.ignoreAnthropicApiKey ? { ANTHROPIC_API_KEY: void 0, ANTHROPIC_AUTH_TOKEN: void 0 } : {}
      },
      terminal: {
        cols: this.o.cols,
        rows: this.o.rows,
        data: (_term, d) => {
          this.lastDataAt = Date.now();
          const chunk = Buffer.from(d).toString("utf8");
          this.raw += chunk;
          if (this.o.debug) process.stdout.write(chunk);
        }
      }
    });
    this.proc.exited.then((code) => {
      this.exitCode = typeof code === "number" ? code : null;
      this.exited = true;
      this.proc = null;
    }).catch(() => {
      this.exited = true;
      this.proc = null;
    });
    await this.waitForBoot();
    this.cursor = this.lineCount();
  }
  /** Wait until the TUI has been quiet for bootQuietMs (Ink ready), bounded by
   *  bootMinMs..bootMaxMs. */
  async waitForBoot() {
    const start = Date.now();
    while (Date.now() - start < this.o.bootMaxMs) {
      await delay(150);
      if (this.aborted) throw new Error("aborted during boot");
      if (this.exited) {
        throw new Error(this.failureMessage("claude exited during boot", true));
      }
      const elapsed = Date.now() - start;
      const sinceData = Date.now() - this.lastDataAt;
      if (elapsed >= this.o.bootMinMs && sinceData >= this.o.bootQuietMs) return;
    }
  }
  /** Submit the freshly-injected prompt and confirm the turn was actually
   *  accepted. A large bracketed paste collapses into a "[Pasted text]"
   *  placeholder; an Enter sent while claude is still ingesting the paste is
   *  silently dropped, so a single fixed-delay Enter races the paste and can
   *  leave the prompt sitting unsubmitted (→ hang until turnTimeoutMs). Send
   *  Enter, then poll for transcript growth past the cursor (the turn's records
   *  are written on acceptance); resend Enter until accepted or the retry
   *  budget is spent. Polling growth (not a blind delay) also stops us from
   *  sending a stray Enter once the turn is in flight. */
  async submitTurn() {
    await delay(this.o.submitMinMs);
    for (let attempt = 0; attempt < this.o.submitMaxRetries; attempt++) {
      if (this.aborted || this.exited || !this.proc) return;
      this.proc.terminal.write("\r");
      const until = Date.now() + this.o.submitConfirmMs;
      while (Date.now() < until) {
        await delay(80);
        if (this.aborted || this.exited) return;
        if (this.lineCount() > this.cursor) return;
      }
    }
  }
  readRawLines() {
    try {
      return fs4.readFileSync(this.jsonlPath, "utf8").split("\n");
    } catch {
      return [];
    }
  }
  /** Count of complete lines (split('\n') minus the trailing/partial element). */
  lineCount() {
    const lines = this.readRawLines();
    return lines.length > 0 ? lines.length - 1 : 0;
  }
  rawTail(max = 600) {
    const clean = this.raw.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").replace(/\s+/g, " ").trim();
    return clean.length > max ? clean.slice(-max) : clean;
  }
  failureMessage(reason, includeRaw = false) {
    const parts = [
      `${reason} (sessionId=${this.sessionId}, jsonlPath=${this.jsonlPath}, exitCode=${this.exitCode ?? "unknown"})`
    ];
    if (includeRaw) {
      const tail = this.rawTail();
      if (tail) parts.push(`terminalTail=${JSON.stringify(tail)}`);
    }
    return parts.join("; ");
  }
  /**
   * Inject a turn into the live session and return the assistant reply once a
   * terminal stop_reason is observed in the transcript.
   */
  async ask(prompt, perTurnTimeoutMs) {
    if (this.aborted) throw new Error("aborted");
    if (!this.proc || this.exited)
      throw new Error("session not started or already exited");
    const timeout = perTurnTimeoutMs ?? this.o.turnTimeoutMs;
    const t0 = Date.now();
    if (this.o.bracketedPaste) {
      this.proc.terminal.write("\x1B[200~" + prompt + "\x1B[201~");
    } else {
      this.proc.terminal.write(prompt);
    }
    await this.submitTurn();
    const collected = [];
    let lastUsage = null;
    let stopReason = null;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await delay(this.o.pollMs);
      if (this.aborted) throw new Error("aborted mid-turn");
      const lines = this.readRawLines();
      const lastComplete = lines.length - 1;
      if (lastComplete <= this.cursor) {
        if (this.exited) throw new Error(this.failureMessage("claude exited mid-turn", true));
        continue;
      }
      for (let i = this.cursor; i < lastComplete; i++) {
        const s = lines[i];
        if (!s || !s.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(s);
        } catch {
          continue;
        }
        if (rec.type === "assistant" && rec.message) {
          for (const b of rec.message.content ?? []) {
            if (b?.type === "text" && typeof b.text === "string")
              collected.push(b.text);
          }
          if (rec.message.usage) lastUsage = rec.message.usage;
          if (rec.message.stop_reason && TERMINAL_STOP.has(rec.message.stop_reason)) {
            stopReason = rec.message.stop_reason;
          }
        }
      }
      this.cursor = lastComplete;
      if (stopReason) break;
    }
    if (!stopReason) {
      throw new Error(
        this.failureMessage(
          `turn timed out after ${timeout}ms (no terminal assistant record; collected ${collected.length} text block(s))`
        )
      );
    }
    const u = lastUsage ?? {};
    return {
      text: collected.join("\n").trim(),
      stopReason,
      usage: lastUsage,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      ephemeral1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      ephemeral5mTokens: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      elapsedMs: Date.now() - t0
    };
  }
  /**
   * Like ask(), but instead of collecting the reply text it re-emits each NEW
   * raw JSONL transcript line via onLine (verbatim) until a terminal
   * stop_reason. Returns the terminal stop_reason + the last assistant usage.
   * Used by the opencode plugin transport shim, which feeds these raw lines
   * into the existing stream-json line handler unchanged.
   */
  async tailTurn(prompt, onLine, perTurnTimeoutMs) {
    if (this.aborted) throw new Error("aborted");
    if (!this.proc || this.exited)
      throw new Error("session not started or already exited");
    const timeout = perTurnTimeoutMs ?? this.o.turnTimeoutMs;
    if (this.o.bracketedPaste) {
      this.proc.terminal.write("\x1B[200~" + prompt + "\x1B[201~");
    } else {
      this.proc.terminal.write(prompt);
    }
    await this.submitTurn();
    let lastUsage = null;
    let totalOutput = 0;
    let stopReason = null;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await delay(this.o.pollMs);
      if (this.aborted) throw new Error("aborted mid-turn");
      const lines = this.readRawLines();
      const lastComplete = lines.length - 1;
      if (lastComplete <= this.cursor) {
        if (this.exited) {
          throw new Error(this.failureMessage("claude exited mid-turn", true));
        }
        continue;
      }
      for (let i = this.cursor; i < lastComplete; i++) {
        const s = lines[i];
        if (!s || !s.trim()) continue;
        onLine(s);
        let rec;
        try {
          rec = JSON.parse(s);
        } catch {
          continue;
        }
        if (rec.type === "assistant" && rec.message) {
          if (rec.message.usage) {
            lastUsage = rec.message.usage;
            totalOutput += rec.message.usage.output_tokens ?? 0;
          }
          if (rec.message.stop_reason && TERMINAL_STOP.has(rec.message.stop_reason)) {
            stopReason = rec.message.stop_reason;
          }
        }
      }
      this.cursor = lastComplete;
      if (stopReason) break;
    }
    let usage = lastUsage;
    if (lastUsage) {
      usage = { ...lastUsage, output_tokens: totalOutput };
      if (Array.isArray(lastUsage.iterations) && lastUsage.iterations.length > 0) {
        const iters = lastUsage.iterations.map((it) => ({ ...it }));
        iters[iters.length - 1] = {
          ...iters[iters.length - 1],
          output_tokens: totalOutput
        };
        usage.iterations = iters;
      }
    }
    if (!stopReason) {
      throw new Error(
        this.failureMessage(
          `turn timed out after ${timeout}ms (no terminal assistant record)`
        )
      );
    }
    return { stopReason, usage };
  }
  dispose() {
    if (this.proc) {
      try {
        this.proc.terminal.write("");
      } catch {
      }
      try {
        this.proc.kill();
      } catch {
      }
      try {
        this.proc.terminal.close();
      } catch {
      }
    }
    this.proc = null;
  }
};

// src/claude-session-wrapper.ts
function decodeUserEnvelope(chunk) {
  let parsed;
  try {
    parsed = JSON.parse(chunk);
  } catch {
    return chunk;
  }
  if (!parsed || parsed.type !== "user" || !parsed.message) return chunk;
  const content = parsed.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return chunk;
  const parts = [];
  let dropped = 0;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block?.type === "tool_result") {
      const v = block.content;
      const text = typeof v === "string" ? v : Array.isArray(v) ? v.map((i) => i?.type === "text" ? i.text : "").filter(Boolean).join("\n") : "";
      parts.push(
        `[Tool result${block.tool_use_id ? ` ${block.tool_use_id}` : ""}]
${text}`
      );
    } else {
      dropped++;
    }
  }
  if (dropped > 0) {
    log.warn("interactive transport dropped non-text content blocks", {
      dropped
    });
  }
  return parts.join("\n\n");
}
function spawnInteractiveProcess(opts) {
  const extraArgs = [];
  if (opts.mcpConfigPaths && opts.mcpConfigPaths.length > 0) {
    extraArgs.push(
      "--mcp-config",
      ...opts.mcpConfigPaths,
      "--strict-mcp-config"
    );
  }
  if (opts.pluginDirs && opts.pluginDirs.length > 0) {
    for (const dir of opts.pluginDirs) {
      extraArgs.push("--plugin-dir", dir);
    }
  }
  if (opts.permissionsAllow && opts.permissionsAllow.length > 0) {
    extraArgs.push(
      "--settings",
      JSON.stringify({ permissions: { allow: opts.permissionsAllow } })
    );
  }
  if (opts.permissionMode === "bypassPermissions") {
    log.warn(
      "interactive permissionMode bypassPermissions ignored: Claude Code prompts for confirmation in the TUI"
    );
  } else if (opts.permissionMode) {
    extraArgs.push("--permission-mode", opts.permissionMode);
  }
  if (opts.systemPromptFile) {
    extraArgs.push("--append-system-prompt-file", opts.systemPromptFile);
  }
  const session = new ClaudeSession({
    cwd: opts.cwd,
    cliPath: opts.cliPath,
    configDir: opts.configDir,
    model: opts.model,
    // Default null = normal CLAUDE.md + settings load, matching what the
    // headless spawn does. "" (skip everything) is for fast e2e runs only.
    settingSources: opts.settingSources === void 0 ? null : opts.settingSources,
    extraArgs,
    ignoreAnthropicApiKey: opts.ignoreAnthropicApiKey
  });
  log.info("prepared interactive claude session", {
    cwd: opts.cwd,
    cliPath: opts.cliPath ?? "claude",
    configDir: session.configDir,
    model: opts.model,
    sessionId: session.sessionId,
    jsonlPath: session.jsonlPath
  });
  const lineEmitter = new EventEmitter2();
  const errorHandlers = /* @__PURE__ */ new Set();
  let startPromise = null;
  const ensureStarted = () => {
    if (!startPromise) startPromise = session.start();
    return startPromise;
  };
  const emitResult = (subtype, isError, result, usage) => {
    lineEmitter.emit(
      "line",
      JSON.stringify({
        type: "result",
        subtype,
        is_error: isError,
        result,
        session_id: session.sessionId,
        usage: usage ?? {},
        total_cost_usd: null,
        duration_ms: 0
      })
    );
  };
  const runTurn = (userMsg) => {
    void (async () => {
      try {
        await ensureStarted();
        const { stopReason, usage } = await session.tailTurn(userMsg, (raw) => {
          lineEmitter.emit("line", raw);
        });
        const timedOut = !stopReason;
        emitResult(
          timedOut ? "error_during_execution" : stopReason,
          timedOut,
          timedOut ? "Interactive transport: the turn ended without a terminal stop_reason (turn timeout or claude exit). Output above may be incomplete." : void 0,
          usage
        );
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        log.error("interactive turn failed", { error: e.message });
        emitResult(
          "error_during_execution",
          true,
          `Interactive transport failed: ${e.message}`
        );
        if (errorHandlers.size > 0) {
          for (const h of errorHandlers) h(e);
        } else {
          lineEmitter.emit("close");
        }
      }
    })();
  };
  const proc = {
    stdin: {
      write(chunk) {
        const raw = typeof chunk === "string" && chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
        runTurn(decodeUserEnvelope(raw));
        return true;
      },
      end() {
      }
    },
    stdout: null,
    stderr: null,
    pid: -1,
    killed: false,
    on(event, fn) {
      if (event === "error") errorHandlers.add(fn);
      return proc;
    },
    once() {
      return proc;
    },
    off(event, fn) {
      if (event === "error") errorHandlers.delete(fn);
      return proc;
    },
    kill() {
      try {
        session.dispose();
      } catch {
      }
      if (opts.systemPromptFile) {
        void unlink2(opts.systemPromptFile).catch(() => {
        });
      }
      proc.killed = true;
      return true;
    }
  };
  return {
    proc,
    lineEmitter,
    proxyServer: null,
    mcpHash: void 0,
    systemPromptFile: opts.systemPromptFile,
    interactive: true
  };
}

// src/proxy-mcp.ts
import { createServer } from "http";
import * as fs5 from "fs";
import * as path5 from "path";
import * as crypto3 from "crypto";
import { EventEmitter as EventEmitter3 } from "events";
var SERVER_CLOSED_MESSAGE = "proxy MCP server closed";
var CLIENT_GONE_MESSAGE = "Claude CLI hung up before the proxy call resolved";
function isExpectedCleanupError(message) {
  return message.includes("timed out after") && message.includes("waiting for opencode to resolve") || message.includes("rejecting as orphaned") || message.includes("was orphaned by a new user turn") || message.includes("stream was aborted") || message.includes(CLIENT_GONE_MESSAGE) || message.includes(SERVER_CLOSED_MESSAGE);
}
var PROTOCOL_VERSION = "2024-11-05";
var SERVER_NAME = "opencode_proxy";
var PROXY_TOOL_PREFIX = `mcp__${SERVER_NAME}__`;
var PROXY_DEFAULT_TIMEOUT_MS = 10 * 60 * 1e3;
var PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS = {
  task: 0,
  task_batch: 0,
  question: 30 * 60 * 1e3
  // 30 min
};
var MAX_PROXY_TIMEOUT_MS = 2 ** 31 - 1;
function resolveProxyCallTimeoutMs(toolName, input, overrides) {
  const key = toolName.toLowerCase();
  let ms = PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS[key] ?? PROXY_DEFAULT_TIMEOUT_MS;
  if (overrides) {
    const ov = lookupCaseInsensitive(overrides, key);
    if (typeof ov === "number" && ov >= 0) ms = ov;
  }
  if (key === "bash") {
    const requested = input?.timeout;
    if (typeof requested === "number" && requested > ms) ms = requested;
  }
  return Math.min(ms, MAX_PROXY_TIMEOUT_MS);
}
function lookupCaseInsensitive(map, key) {
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  for (const k of Object.keys(map)) {
    if (k.toLowerCase() === key) return map[k];
  }
  return void 0;
}
function resolveProxyClientCeilingMs(overrides) {
  let ms = PROXY_DEFAULT_TIMEOUT_MS;
  for (const [toolName, defaultMs] of Object.entries(
    PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS
  )) {
    const override = overrides ? lookupCaseInsensitive(overrides, toolName) : void 0;
    const effectiveMs = typeof override === "number" && override >= 0 ? override : defaultMs;
    if (effectiveMs === 0) return MAX_PROXY_TIMEOUT_MS;
    if (effectiveMs > ms) ms = effectiveMs;
  }
  if (overrides) {
    for (const v of Object.values(overrides)) {
      if (v === 0) return MAX_PROXY_TIMEOUT_MS;
      if (typeof v === "number" && v > ms) ms = v;
    }
  }
  return Math.min(ms, MAX_PROXY_TIMEOUT_MS);
}
function buildProxyTimeoutError(toolName, ms) {
  const key = toolName.toLowerCase();
  const base = `Proxy tool '${toolName}' timed out after ${ms}ms waiting for opencode to resolve the call`;
  if (key === "task" || key === TASK_BATCH_TOOL_NAME) {
    return new Error(
      base + " (the subagent). The subagent may still be running but its result is no longer reachable in this session. Do not declare the dispatch failed, and do not 'schedule a wake-up' or defer -- that mechanism does not apply here. If the result is required, re-dispatch or verify it directly now."
    );
  }
  return new Error(base);
}
var TASK_PROXY_NOTE = "The task and task_batch proxies are the ONLY tools that dispatch opencode subagents (including user @-mentions). Claude Code's built-in TaskCreate/TaskUpdate manage a local todo list and cannot dispatch subagents. Do not search config files to verify a subagent type exists \u2014 invalid types fail fast with a clear error. Foreground calls block until the subagent finishes; set `background` to request opencode's background execution mode. Task and task_batch calls have no proxy deadline by default; set a positive proxyToolTimeoutMs override if you want a backstop.";
var AGENT_TYPES_HEADING = "Available agent types";
var AGENT_BLURB_LIMIT = 140;
var QUESTION_PROXY_NOTE = "This routes structured questions through opencode's native `question` tool, which renders a TUI form with the options you provide and blocks until the operator answers. Claude Code's built-in AskUserQuestion is disabled in this environment; this proxy is the ONLY way to ask the operator for a decision or clarification. Answers come back as arrays of selected labels (set `multiple: true` to allow more than one). If the operator dismisses the form the call returns an error \u2014 treat that as 'no answer' and stop, do not guess. Question calls get a 30-minute proxy deadline by default (configurable via proxyToolTimeoutMs); for long-AFK scenarios prefer fewer, high-signal questions.";
function extractAgentTypeList(liveDescription) {
  const live = liveDescription?.trim();
  if (!live) return void 0;
  const start = live.indexOf(AGENT_TYPES_HEADING);
  if (start === -1) return void 0;
  const entries = [];
  for (const raw of live.slice(start).split("\n")) {
    const match = /^-\s*([^:]+):\s*(.+)$/.exec(raw.trim());
    if (!match) continue;
    const name = match[1].trim();
    const blurb = match[2].trim();
    entries.push(
      `- ${name}: ${blurb.length > AGENT_BLURB_LIMIT ? `${blurb.slice(0, AGENT_BLURB_LIMIT).trimEnd()}\u2026` : blurb}`
    );
  }
  if (entries.length === 0) return void 0;
  return `Valid subagent_type values, from opencode's live registry \u2014 anything else fails:
${entries.join("\n")}`;
}
function overlayTaskProxyDescription(tools, liveDescription) {
  const agentTypes = extractAgentTypeList(liveDescription);
  if (!agentTypes) return tools;
  return tools.map(
    (t) => t.name === "task" ? { ...t, description: `${agentTypes}

${t.description}` } : t
  );
}
function overlayQuestionProxyDescription(tools, liveDescription) {
  const live = liveDescription?.trim();
  if (!live) return tools;
  return tools.map(
    (t) => t.name === "question" ? { ...t, description: `${live}

${QUESTION_PROXY_NOTE}` } : t
  );
}
function filterQuestionProxyByOpencodeSupport(tools, opencodeHasQuestion) {
  if (opencodeHasQuestion) return tools;
  return tools.filter((t) => t.name !== "question");
}
var PROXY_HEARTBEAT_MS = 60 * 1e3;
var TASK_BATCH_TOOL_NAME = "task_batch";
var TASK_INPUT_PROPERTIES = {
  description: {
    type: "string",
    description: "A short (3-5 words) description of the task"
  },
  prompt: {
    type: "string",
    description: "The task for the agent to perform"
  },
  subagent_type: {
    type: "string",
    description: "The type of specialized agent to use for this task"
  },
  task_id: {
    type: "string",
    description: "Set this only if you mean to resume a previous task \u2014 pass the prior task_id to continue the same subagent session instead of creating a fresh one."
  },
  command: {
    type: "string",
    description: "The command that triggered this task"
  },
  background: {
    type: "boolean",
    description: "Run the task in the background when supported by opencode"
  }
};
var TASK_INPUT_REQUIRED = ["description", "prompt", "subagent_type"];
function taskBatchInputError(input) {
  if (!Array.isArray(input.tasks) || input.tasks.length < 2) {
    return "task_batch requires a tasks array with at least two items";
  }
  for (const [index, task] of input.tasks.entries()) {
    if (task === null || typeof task !== "object" || Array.isArray(task)) {
      return `task_batch tasks[${index}] must be an object`;
    }
    const item = task;
    for (const field of TASK_INPUT_REQUIRED) {
      if (typeof item[field] !== "string") {
        return `task_batch tasks[${index}].${field} must be a string`;
      }
    }
  }
  return null;
}
var DEFAULT_PROXY_TOOLS = [
  {
    name: "bash",
    description: "Execute a shell command. Routed through opencode's bash tool so permission prompts flow through opencode's UI.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute."
        },
        description: {
          type: "string",
          description: "Short human-readable description of what the command does."
        },
        timeout: {
          type: "number",
          description: "Optional timeout in milliseconds."
        }
      },
      required: ["command"]
    }
  },
  {
    name: "write",
    description: "Write a file. Routed through opencode's write tool so permission prompts flow through opencode's UI.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The file to write. Absolute paths are preferred."
        },
        content: {
          type: "string",
          description: "The full content to write to the file."
        }
      },
      required: ["filePath", "content"]
    }
  },
  {
    name: "edit",
    description: "Replace text in an existing file. Routed through opencode's edit tool so permission prompts flow through opencode's UI.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The file to edit. Absolute paths are preferred."
        },
        oldString: {
          type: "string",
          description: "The exact text to replace."
        },
        newString: {
          type: "string",
          description: "The replacement text."
        },
        replaceAll: {
          type: "boolean",
          description: "Replace all occurrences instead of just the first one."
        }
      },
      required: ["filePath", "oldString", "newString"]
    }
  },
  {
    name: "webfetch",
    description: "Fetch content from a URL. Routed through opencode's webfetch tool so permission prompts flow through opencode's UI. Returns the page content in the requested format.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch content from. Must start with http:// or https://."
        },
        format: {
          type: "string",
          enum: ["text", "markdown", "html"],
          description: "The format to return the content in. Defaults to markdown."
        },
        timeout: {
          type: "number",
          description: "Optional timeout in seconds (max 120)."
        }
      },
      required: ["url"]
    }
  },
  {
    name: "task",
    description: "Launch an opencode subagent to handle a complex multi-step task autonomously. Routed through opencode's task tool so subagent orchestration, permission, and lifecycle are handled by opencode. Use `subagent_type` to pick which configured subagent runs (e.g. `build`, `general`, `explore`, or any custom subagent declared in opencode.json). For two or more independent subagents, use task_batch instead of emitting multiple task calls; Claude Code executes MCP calls serially, while task_batch fans them out concurrently in opencode. " + TASK_PROXY_NOTE,
    inputSchema: {
      type: "object",
      properties: TASK_INPUT_PROPERTIES,
      required: TASK_INPUT_REQUIRED
    }
  },
  {
    name: TASK_BATCH_TOOL_NAME,
    description: "Launch two or more independent opencode subagents concurrently. Put one ordinary task input in `tasks` for each subagent. This is the required concurrency path: make one task_batch call rather than multiple task calls in the same response. The plugin fans the array out as parallel opencode task calls and returns all results together.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 2,
          description: "Independent subagent tasks to execute concurrently",
          items: {
            type: "object",
            properties: TASK_INPUT_PROPERTIES,
            required: TASK_INPUT_REQUIRED
          }
        }
      },
      required: ["tasks"]
    }
  },
  {
    name: "question",
    description: "Ask the operator structured questions with options and receive their answers back. Routed through opencode's native `question` tool so the prompt renders as a real TUI form (with options and a custom-answer field) instead of a plain text turn. Use this when you need a decision, clarification, or preference from the operator mid-task. " + QUESTION_PROXY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask.",
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "Complete question."
              },
              header: {
                type: "string",
                description: "Very short label (max 30 chars)."
              },
              options: {
                type: "array",
                description: "Available choices.",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "Display text (1-5 words, concise)."
                    },
                    description: {
                      type: "string",
                      description: "Explanation of choice."
                    }
                  },
                  required: ["label", "description"]
                }
              },
              multiple: {
                type: "boolean",
                description: "Allow selecting multiple choices. Defaults to false."
              }
            },
            required: ["question", "header", "options"]
          }
        }
      },
      required: ["questions"]
    }
  }
];
async function createProxyMcpServer(tools = DEFAULT_PROXY_TOOLS, timeoutOverrides) {
  const calls = new EventEmitter3();
  const pending = /* @__PURE__ */ new Map();
  const server2 = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
      res.statusCode = 404;
      res.end();
      return;
    }
    let requestId = null;
    let requestMethod = null;
    try {
      const body = await readBody(req);
      const request = JSON.parse(body);
      requestId = request?.id ?? null;
      requestMethod = typeof request?.method === "string" ? request.method : null;
      if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          error: { code: -32600, message: "Invalid request" }
        });
        return;
      }
      log.debug("proxy-mcp request", {
        method: request.method,
        id: request.id
      });
      if (request.method === "initialize") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: {
              name: SERVER_NAME,
              version: "0.1.0"
            }
          }
        });
        return;
      }
      if (request.method === "notifications/initialized") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (request.method === "tools/list") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          result: {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema
            }))
          }
        });
        return;
      }
      if (request.method === "tools/call") {
        const params = request.params ?? {};
        const toolName = String(params.name ?? "");
        const input = params.arguments ?? {};
        if (!tools.some((t) => t.name === toolName)) {
          writeJson(res, {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              content: [{ type: "text", text: `Unknown proxy tool: ${toolName}` }],
              isError: true
            }
          });
          return;
        }
        if (toolName === TASK_BATCH_TOOL_NAME) {
          const validationError = taskBatchInputError(input);
          if (validationError) {
            writeJson(res, {
              jsonrpc: "2.0",
              id: requestId,
              result: {
                content: [{ type: "text", text: validationError }],
                isError: true
              }
            });
            return;
          }
        }
        const callId = crypto3.randomUUID();
        log.info("proxy-mcp tool call received", {
          callId,
          toolName,
          hasInput: input != null
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.flushHeaders();
        const heartbeat = setInterval(() => {
          if (res.writableEnded) return;
          try {
            res.write(" ");
          } catch {
          }
        }, PROXY_HEARTBEAT_MS);
        heartbeat.unref?.();
        let timer = null;
        const result = await new Promise(
          (resolve5, reject) => {
            const entry = {
              id: callId,
              toolName,
              input,
              resolve: resolve5,
              reject
            };
            pending.set(callId, entry);
            res.on("close", () => {
              if (res.writableEnded) return;
              if (!pending.has(callId)) return;
              pending.delete(callId);
              log.notice("proxy client hung up before the call resolved", {
                callId,
                toolName
              });
              calls.emit("cancel", { id: callId, toolName });
              reject(new Error(`${CLIENT_GONE_MESSAGE}: ${toolName}`));
            });
            const deadlineMs = resolveProxyCallTimeoutMs(
              toolName,
              input,
              timeoutOverrides
            );
            if (deadlineMs > 0) {
              timer = setTimeout(() => {
                if (!pending.has(callId)) return;
                pending.delete(callId);
                log.notice("proxy-mcp tool call timed out", {
                  callId,
                  toolName,
                  deadlineMs
                });
                reject(buildProxyTimeoutError(toolName, deadlineMs));
              }, deadlineMs);
            }
            calls.emit("call", entry);
          }
        ).finally(() => {
          if (timer) clearTimeout(timer);
          clearInterval(heartbeat);
          pending.delete(callId);
        });
        const text = result.kind === "error" ? result.message : result.text;
        const isError = result.kind === "error" || result.isError === true;
        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          result: {
            content: [{ type: "text", text }],
            isError
          }
        });
        return;
      }
      writeJson(res, {
        jsonrpc: "2.0",
        id: requestId,
        error: { code: -32601, message: `Unknown method: ${request.method}` }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const logFn = isExpectedCleanupError(errorMessage) ? log.notice : log.warn;
      logFn("proxy-mcp error handling request", {
        error: errorMessage
      });
      if (requestMethod === "tools/call") {
        try {
          writeJson(res, {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              content: [{ type: "text", text: errorMessage }],
              isError: true
            }
          });
        } catch {
          try {
            res.statusCode = 500;
            res.end();
          } catch {
          }
        }
        return;
      }
      try {
        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal error"
          }
        });
      } catch {
        try {
          res.statusCode = 500;
          res.end();
        } catch {
        }
      }
    }
  });
  server2.requestTimeout = 0;
  await new Promise((resolve5, reject) => {
    server2.once("error", reject);
    server2.listen(0, "127.0.0.1", () => {
      server2.off("error", reject);
      resolve5();
    });
  });
  const addr = server2.address();
  if (!addr) {
    server2.close();
    throw new Error("Failed to bind proxy MCP server");
  }
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  log.info("proxy-mcp server started", {
    url,
    tools: tools.map((t) => t.name)
  });
  let configFilePath = null;
  const api = {
    url,
    serverName: SERVER_NAME,
    tools,
    calls,
    configPath() {
      if (configFilePath) return configFilePath;
      const body = JSON.stringify(
        {
          mcpServers: {
            [SERVER_NAME]: {
              type: "http",
              url,
              timeout: resolveProxyClientCeilingMs(timeoutOverrides)
            }
          }
        },
        null,
        2
      );
      const hash = crypto3.createHash("sha256").update(body).digest("hex").slice(0, 12);
      const outPath = path5.join(
        pluginTmpDir(),
        `proxy-${hash}.json`
      );
      fs5.writeFileSync(outPath, body, { encoding: "utf8", mode: 384 });
      configFilePath = outPath;
      return outPath;
    },
    async close() {
      for (const entry of pending.values()) {
        entry.reject(new Error(SERVER_CLOSED_MESSAGE));
      }
      pending.clear();
      await new Promise((resolve5) => {
        server2.close(() => resolve5());
      });
      if (configFilePath) {
        try {
          fs5.unlinkSync(configFilePath);
        } catch {
        }
        configFilePath = null;
      }
    }
  };
  return api;
}
function disallowedToolFlags(tools) {
  const nameMap = {
    bash: ["Bash"],
    read: ["Read"],
    write: ["Write"],
    edit: ["Edit", "MultiEdit"],
    glob: ["Glob"],
    grep: ["Grep"],
    webfetch: ["WebFetch"],
    task: ["Agent"],
    task_batch: ["Agent"],
    // `question` disables Claude Code's built-in `AskUserQuestion` so the
    // structured-questions path flows through opencode's native `question`
    // tool instead — same UI/permission/audit benefits as the other
    // proxies. Without this, the model can call both and the two paths
    // diverge (opencode's form vs the headless deny-and-render fallback).
    question: ["AskUserQuestion"]
  };
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const t of tools) {
    const mapped = nameMap[t.name.toLowerCase()];
    if (!mapped) continue;
    for (const claudeTool of mapped) {
      if (seen.has(claudeTool)) continue;
      seen.add(claudeTool);
      out.push(claudeTool);
    }
  }
  return out;
}
function readBody(req) {
  return new Promise((resolve5, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve5(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function writeJson(res, body) {
  const payload = JSON.stringify(body);
  if (res.headersSent) {
    res.end(payload);
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(payload).toString());
  res.end(payload);
}

// src/proxy-broker.ts
import { EventEmitter as EventEmitter4 } from "events";
var pendingByCallId = /* @__PURE__ */ new Map();
var callIdsBySession = /* @__PURE__ */ new Map();
var emitter = new EventEmitter4();
function eventName(sessionKey2) {
  return `pending:${sessionKey2}`;
}
function indexAdd(sessionKey2, callId) {
  let s = callIdsBySession.get(sessionKey2);
  if (!s) {
    s = /* @__PURE__ */ new Set();
    callIdsBySession.set(sessionKey2, s);
  }
  s.add(callId);
}
function indexRemove(sessionKey2, callId) {
  const s = callIdsBySession.get(sessionKey2);
  if (!s) return;
  s.delete(callId);
  if (s.size === 0) callIdsBySession.delete(sessionKey2);
}
function onPendingProxyCall(sessionKey2, handler) {
  const name = eventName(sessionKey2);
  emitter.on(name, handler);
  return () => emitter.off(name, handler);
}
function queuePendingProxyCall(sessionKey2, call, timeoutOverridesOrDeadlineMs) {
  const previous = pendingByCallId.get(call.id);
  if (previous) {
    if (previous.timer) clearTimeout(previous.timer);
    previous.reject(
      new Error(`Replaced pending proxy call ${call.id} with a fresh one`)
    );
    pendingByCallId.delete(call.id);
    indexRemove(previous.sessionKey, call.id);
  }
  const deadlineMs = typeof timeoutOverridesOrDeadlineMs === "number" ? timeoutOverridesOrDeadlineMs : resolveProxyCallTimeoutMs(
    call.toolName,
    call.input,
    timeoutOverridesOrDeadlineMs
  );
  const timer = deadlineMs > 0 ? setTimeout(() => {
    const current = pendingByCallId.get(call.id);
    if (!current) return;
    pendingByCallId.delete(call.id);
    indexRemove(current.sessionKey, call.id);
    current.reject(buildProxyTimeoutError(call.toolName, deadlineMs));
    log.notice("timed out pending proxy call", {
      sessionKey: current.sessionKey,
      toolCallId: call.id,
      toolName: call.toolName,
      deadlineMs
    });
  }, deadlineMs) : null;
  const pending = {
    sessionKey: sessionKey2,
    toolCallId: call.id,
    toolName: call.toolName,
    input: call.input,
    createdAt: Date.now(),
    timer,
    resolve: call.resolve,
    reject: call.reject
  };
  pendingByCallId.set(call.id, pending);
  indexAdd(sessionKey2, call.id);
  emitter.emit(eventName(sessionKey2), pending);
  log.info("queued pending proxy call", {
    sessionKey: sessionKey2,
    toolCallId: call.id,
    toolName: call.toolName
  });
  return pending;
}
function getPendingProxyCalls(sessionKey2) {
  const s = callIdsBySession.get(sessionKey2);
  if (!s || s.size === 0) return [];
  const out = [];
  for (const id of s) {
    const p = pendingByCallId.get(id);
    if (p) out.push(p);
  }
  return out;
}
function resolvePendingProxyCallById(toolCallId, result) {
  const pending = pendingByCallId.get(toolCallId);
  if (!pending) return false;
  pendingByCallId.delete(toolCallId);
  indexRemove(pending.sessionKey, toolCallId);
  if (pending.timer) clearTimeout(pending.timer);
  pending.resolve(result);
  log.info("resolved pending proxy call", {
    sessionKey: pending.sessionKey,
    toolCallId: pending.toolCallId,
    toolName: pending.toolName
  });
  return true;
}
function rejectPendingProxyCallById(toolCallId, error) {
  const pending = pendingByCallId.get(toolCallId);
  if (!pending) return false;
  pendingByCallId.delete(toolCallId);
  indexRemove(pending.sessionKey, toolCallId);
  if (pending.timer) clearTimeout(pending.timer);
  pending.reject(error);
  log.notice("rejected pending proxy call", {
    sessionKey: pending.sessionKey,
    toolCallId: pending.toolCallId,
    toolName: pending.toolName,
    error: error.message
  });
  return true;
}
function rejectAllPendingProxyCallsForSession(sessionKey2, error) {
  const s = callIdsBySession.get(sessionKey2);
  if (!s) return 0;
  const ids = [...s];
  let count = 0;
  for (const id of ids) {
    if (rejectPendingProxyCallById(id, error)) count++;
  }
  return count;
}

// src/claude-code-language-model.ts
import { readFileSync as readFileSync3, writeFileSync as writeFileSync4 } from "fs";
import { unlink as unlink3 } from "fs/promises";
import { homedir as homedir5, tmpdir as tmpdir2 } from "os";
import { randomUUID as randomUUID4 } from "crypto";
import { dirname as dirname4, join as join7 } from "path";
var DEFAULT_COMPACTION_MODEL = "claude-haiku-4-5";
function resolveCompactionModel(configured) {
  const env = process.env.CLAUDE_CODE_COMPACTION_MODEL?.trim();
  if (env) return env;
  const trimmed = configured?.trim();
  if (trimmed) return trimmed;
  return DEFAULT_COMPACTION_MODEL;
}
function resolveSessionAffinity(headers, providerOptions, providerKey) {
  if (headers) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "x-session-affinity") {
        const v = headers[key];
        if (typeof v === "string" && v.length > 0) return v;
      }
    }
  }
  if (providerOptions) {
    const bag = providerOptions[providerKey] ?? providerOptions["claude-code"];
    const sid = bag?.opencodeSessionID;
    if (typeof sid === "string" && sid.length > 0) return sid;
  }
  return "default";
}
var KNOWN_DELTA_TYPES = /* @__PURE__ */ new Set([
  "thinking_delta",
  "text_delta",
  "input_json_delta",
  "signature_delta"
]);
function hasNewUserContent(prompt) {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i];
    if (msg.role === "assistant") return false;
    if (msg.role === "tool") {
      const content2 = msg.content;
      if (Array.isArray(content2)) {
        for (const part of content2) {
          if (part?.type === "tool-result") return true;
        }
      }
      continue;
    }
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") {
      if (content.trim()) return true;
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text" && part.text && part.text.trim()) return true;
        if (part.type === "tool-result") return true;
        if (part.type === "image" || part.type === "file") return true;
      }
    }
  }
  return false;
}
function taskBatchTasks(input) {
  if (!Array.isArray(input.tasks)) return [];
  if (input.tasks.some(
    (task) => task === null || typeof task !== "object" || Array.isArray(task)
  )) {
    return [];
  }
  return input.tasks;
}
function taskBatchChildToolCallId(parentToolCallId, index) {
  return `${parentToolCallId}_task_${index}`;
}
var AUTO_CONTINUE_MAX_ATTEMPTS = 8;
var AUTO_CONTINUE_MAX_ELAPSED_MS = 10 * 60 * 1e3;
var AUTO_CONTINUE_NO_PROGRESS_LIMIT = 2;
var PROXY_RESULT_BOUNDARY_GRACE_MS = 250;
var AUTO_CONTINUE_PROMPT = "Continue the task from where you stopped. Do not summarize; keep working until the requested task is complete, you need clarification, or you hit a real blocker.";
function normalizeVisibleText(text) {
  return text.replace(/\s+/g, " ").trim();
}
function isAskUserQuestionTool(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return n === "askuserquestion" || n === "ask_user_question";
}
var ASK_USER_QUESTION_DENY_MESSAGE = "Your question and its options have already been presented to the operator verbatim. This is NOT a cancellation or a refusal \u2014 the operator simply has not answered yet. Stop now: end your turn without calling any more tools and without answering the question yourself. Do not say the question was cancelled, skipped, or declined, and do not guess, assume, or proceed on their behalf. Wait for the operator's reply, which arrives as the next user message.";
function denyMessageForTool(toolName, configuredDenyMessage) {
  if (isAskUserQuestionTool(toolName)) return ASK_USER_QUESTION_DENY_MESSAGE;
  return configuredDenyMessage ?? `Denied by opencode-claude-code policy for tool ${toolName}`;
}
function formatAskUserQuestion(input) {
  const anyInput = input;
  const questions = Array.isArray(anyInput?.questions) ? anyInput.questions : [];
  if (questions.length === 0) {
    const single = anyInput?.question ?? anyInput?.text;
    const q = typeof single === "string" && single.trim() ? single.trim() : "Question?";
    return `

**${q}**

_Reply with your answer to continue._

`;
  }
  const out = ["\n\n"];
  const multiQ = questions.length > 1;
  questions.forEach((q, i) => {
    const text = typeof q?.question === "string" && q.question.trim() || typeof q?.text === "string" && q.text.trim() || "Question?";
    const header = typeof q?.header === "string" && q.header.trim() ? q.header.trim() : "";
    out.push(`**${multiQ ? `${i + 1}. ` : ""}${text}**`);
    if (header) out.push(` _(${header})_`);
    out.push("\n\n");
    const options = Array.isArray(q?.options) ? q.options : [];
    options.forEach((opt, j) => {
      const label = typeof opt?.label === "string" && opt.label.trim() || typeof opt === "string" && opt.trim() || `Option ${j + 1}`;
      const desc = typeof opt?.description === "string" && opt.description.trim() ? ` \u2014 ${opt.description.trim()}` : "";
      out.push(`${j + 1}. **${label}**${desc}
`);
    });
    out.push(
      q?.multiSelect === true ? "\n_Select one or more \u2014 reply with the numbers or labels._\n\n" : "\n_Reply with your choice (the number or label)._\n\n"
    );
  });
  return out.join("");
}
function looksLikeQuestion(text) {
  const normalized = normalizeVisibleText(text).toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("?")) return true;
  return /\b(please confirm|can you confirm|should i|would you like|do you want|which option|choose|pick one|need your|need you to|what would you like|let me know if|let me know whether|let me know what|let me know when|let me know how|if you'?d like|if you want to|tell me if|tell me which|tell me whether|say (?:go|yes|no)|push back|sign off|sounds? (?:good|right)|your call|your move|your turn|over to you|all yours|up to you|ready to (?:ship|go|proceed|merge)|ready (?:when|whenever|once|if) you|standing by|i'?ll stand ?by|i'?m here|happy to (?:ship|go|proceed|merge))\b/.test(normalized);
}
function looksLikeBlocker(text) {
  const normalized = normalizeVisibleText(text).toLowerCase();
  if (!normalized) return false;
  return /\b(blocked|blocker|cannot proceed|can't proceed|unable to proceed|need clarification|need more information|permission denied|failed and needs|requires your|needs your|needs you to|action required|manual step|required from you)\b/.test(normalized);
}
function looksLikeFinalAnswer(text) {
  const normalized = normalizeVisibleText(text).toLowerCase();
  if (looksLikeQuestion(normalized) || looksLikeBlocker(normalized)) return false;
  if (/\b(we'?re done|we are done|all done|all set)\b/.test(normalized)) {
    return true;
  }
  if (normalized.length < 30) return false;
  return /\b(done|completed|fixed|implemented|verified|published|released|sent|delivered|updated|shipped|deployed|merged|tagged|live|pinned)\b/.test(normalized) || // v0.4.15: also accept present-tense "tests pass" / "checks pass".
  // Real fire 03:31 ended in "78/78 tests pass" — past-tense-only regex
  // missed it.
  /\b(checks?|tests?) (?:pass|passes|passed)\b/.test(normalized) || /\b(summary|what changed|verification)\b/.test(normalized);
}
function continuationSignature(snapshot) {
  const text = normalizeVisibleText(snapshot.text).slice(-500);
  return JSON.stringify({
    text,
    reasoning: snapshot.hadReasoning,
    tools: snapshot.hadToolActivity,
    proxy: snapshot.hadProxyActivity
  });
}
function shouldAutoContinueIncompleteTurn(state, snapshot) {
  if (state.enabled === false) return { continue: false, reason: "disabled" };
  if (snapshot.isError) return { continue: false, reason: "error" };
  if (state.aborted) return { continue: false, reason: "aborted" };
  if (state.sawAskUserQuestion) return { continue: false, reason: "question" };
  if (snapshot.stopReason) {
    return {
      continue: false,
      reason: snapshot.stopReason.replace(/_/g, "-")
    };
  }
  if (state.attempts >= AUTO_CONTINUE_MAX_ATTEMPTS) {
    return { continue: false, reason: "max-attempts" };
  }
  const now = snapshot.now ?? Date.now();
  if (now - state.startedAt > AUTO_CONTINUE_MAX_ELAPSED_MS) {
    return { continue: false, reason: "max-elapsed" };
  }
  const text = normalizeVisibleText(snapshot.text);
  const lastText = normalizeVisibleText(snapshot.lastVisibleText);
  if (looksLikeQuestion(text)) return { continue: false, reason: "question" };
  if (looksLikeBlocker(text)) return { continue: false, reason: "blocker" };
  if (looksLikeFinalAnswer(lastText)) {
    return { continue: false, reason: "final-answer" };
  }
  const hadActivity = snapshot.hadReasoning || snapshot.hadToolActivity || snapshot.hadProxyActivity;
  if (!hadActivity) return { continue: false, reason: "no-activity" };
  const signature = continuationSignature(snapshot);
  const noProgress = signature === state.lastSignature;
  if (noProgress && state.noProgressCount + 1 >= AUTO_CONTINUE_NO_PROGRESS_LIMIT) {
    return { continue: false, reason: "no-progress" };
  }
  if (!text) {
    return { continue: true, reason: "activity-without-visible-answer" };
  }
  return { continue: true, reason: "non-final-progress" };
}
function makeAutoContinueMessage() {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: AUTO_CONTINUE_PROMPT }]
    }
  });
}
function readPromptFileIfPresent(path8) {
  try {
    const content = readFileSync3(path8, "utf8").trim();
    return content || void 0;
  } catch {
    return void 0;
  }
}
function nearestWorkspaceAgentsPrompt(cwd) {
  let dir = cwd;
  while (true) {
    const content = readPromptFileIfPresent(join7(dir, "AGENTS.md"));
    if (content) return content;
    const parent = dirname4(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
}
var AGENTS_MAINTENANCE_HINT = `## Keeping AGENTS.md up to date

When you complete a task, phase, or to-do item that is listed in AGENTS.md, update the file
immediately after the work is done \u2014 mark it \u2705, check it off, or remove it. Do this inside
the same turn so the next session does not repeat work that is already finished.`;
var MULTI_STEP_TASK_HINT = `## Continuing through multi-step tasks

opencode requires the user to press "continue" after each turn ends. When a
task has multiple steps, do them all in one turn \u2014 chain tool calls rather
than pausing for user confirmation between subtasks. End the turn only
when the task is done, you need clarification on intent, or you hit a real
blocker. The user can interrupt or abort at any time; turn endings should
mark meaningful checkpoints, not every completed substep.`;
var TASK_BATCH_HINT = `## Concurrent opencode subagents

When the \`task_batch\` tool is available, you MUST use one \`task_batch\` call
for two or more independent subagents. Put each ordinary task input in its
\`tasks\` array. Do not emit multiple \`task\` calls for concurrency in this
runtime: Claude Code executes those MCP requests serially, while \`task_batch\`
fans them out concurrently inside opencode. Instructions elsewhere to put
parallel task calls in one response are satisfied here by one \`task_batch\` call.`;
var SUBAGENT_DISPATCH_HINT = `## opencode subagents

Subagent dispatch in this environment goes through exactly one tool: \`mcp__opencode_proxy__task\`.

- When the user mentions \`@<agent>\` or an instruction says "call the task tool with subagent: <name>", call \`mcp__opencode_proxy__task\` with \`subagent_type: "<name>"\`.
- If that tool is not in your visible tool list it is deferred \u2014 load it with ToolSearch (\`select:mcp__opencode_proxy__task\`), then call it.
- Claude Code's built-in TaskCreate/TaskUpdate/TaskList manage a local todo list. They cannot dispatch subagents; creating a task there runs nothing. Never report a subagent as dispatched unless \`mcp__opencode_proxy__task\` returned its result.
- Do not verify a subagent's existence by searching config files \u2014 the tool's description lists the available agent types, and invalid types fail fast with a clear error.`;
var QUESTION_PROXY_HINT = `## Asking the operator questions

Structured questions in this environment go through exactly one tool: \`mcp__opencode_proxy__question\`.

- When you need to ask the operator a question with options, call \`mcp__opencode_proxy__question\` with a \`questions\` array (each item has \`question\`, \`header\`, \`options\` of \`{label, description}\`, and optional \`multiple\`).
- If that tool is not in your visible tool list it is deferred \u2014 load it with ToolSearch (\`select:mcp__opencode_proxy__question\`), then call it by its FULL name.
- Do NOT call bare \`question\` \u2014 that is not a tool. Always use the full \`mcp__opencode_proxy__question\` name when invoking it.
- Claude Code's built-in \`AskUserQuestion\` is disabled in this environment; the proxy is the only way to ask structured questions.`;
var CLAUDE_CLI_CONTEXT_NOTE = `## Runtime environment: Claude Code CLI

You are running via the Claude Code CLI (not a direct API call). This affects context management:

- The \`compress\` tool is NOT available. Do not attempt to call it.
- The \`distill\`, \`prune\`, and \`extract\` tools are NOT available.
- Context window management is handled automatically by Claude CLI's own session history.
- Ignore any system instructions that tell you to call \`compress\` \u2014 they are intended for direct API providers, not this environment.
- DCP context injections (AGENTS.md, dynamic state) arrive via the system prompt and are already applied.`;
function extractSystemMessages(prompt) {
  const out = [];
  for (const msg of prompt) {
    if (msg.role !== "system") continue;
    if (typeof msg.content === "string") {
      if (msg.content.trim()) out.push(msg.content.trim());
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          out.push(part.text.trim());
        }
      }
    }
  }
  return out;
}
function buildAppendedSystemPrompt(cwd, includeMultiStepHint = true, extraSystemContent = [], includeTaskBatchHint = false) {
  const parts = [];
  parts.push(CLAUDE_CLI_CONTEXT_NOTE);
  for (const s of extraSystemContent) {
    if (s.trim()) parts.push(s.trim());
  }
  const configRoot = process.env.XDG_CONFIG_HOME ?? join7(homedir5(), ".config");
  const globalAgents = readPromptFileIfPresent(join7(configRoot, "opencode", "AGENTS.md"));
  const workspaceAgents = nearestWorkspaceAgentsPrompt(cwd);
  if (globalAgents) parts.push(globalAgents);
  if (workspaceAgents && workspaceAgents !== globalAgents) parts.push(workspaceAgents);
  if (globalAgents || workspaceAgents) parts.push(AGENTS_MAINTENANCE_HINT);
  if (includeMultiStepHint) parts.push(MULTI_STEP_TASK_HINT);
  if (includeTaskBatchHint) parts.push(TASK_BATCH_HINT);
  const content = parts.join("\n\n");
  if (!content) return void 0;
  const path8 = join7(tmpdir2(), `opencode-cc-sys-${randomUUID4()}.md`);
  try {
    writeFileSync4(path8, content, "utf8");
    return path8;
  } catch (err) {
    log.warn("failed to write system prompt file", { error: String(err) });
    return void 0;
  }
}
var ClaudeCodeLanguageModel = class {
  specificationVersion = "v3";
  modelId;
  config;
  constructor(modelId, config) {
    this.modelId = modelId;
    this.config = config;
  }
  supportedUrls = {};
  get provider() {
    return this.config.provider;
  }
  toUsage(rawUsage) {
    const iter = rawUsage?.iterations;
    const effective = iter?.length ? iter[iter.length - 1] : rawUsage;
    const noCache = effective?.input_tokens ?? 0;
    const cacheRead = effective?.cache_read_input_tokens ?? 0;
    const cacheWrite = effective?.cache_creation_input_tokens ?? 0;
    return {
      inputTokens: {
        total: noCache + cacheRead + cacheWrite,
        noCache,
        cacheRead: cacheRead || void 0,
        cacheWrite: cacheWrite || void 0
      },
      outputTokens: {
        total: effective?.output_tokens,
        text: effective?.output_tokens,
        reasoning: void 0
      },
      raw: rawUsage
    };
  }
  toFinishReason(reason = "stop") {
    return {
      unified: reason,
      raw: reason
    };
  }
  requestScope(options) {
    const tools = options?.tools;
    if (Array.isArray(tools)) return "tools";
    if (tools && typeof tools === "object") {
      return Object.keys(tools).length > 0 ? "tools" : "no-tools";
    }
    return "no-tools";
  }
  /**
   * Build the combined `--mcp-config` list and return both the list and the
   * hash of the bridged opencode MCP block (or null when bridging is off /
   * yields nothing). The hash is used to detect mid-session config changes
   * and respawn the underlying claude process.
   *
   * `runtimeStatus` is a snapshot of opencode's `client.mcp.status()`. When
   * provided it overlays opencode's UI-toggled state on top of disk config
   * so `/mcps` toggles propagate without a config file write.
   */
  effectiveMcpConfig(cwd, proxyConfigPath, runtimeStatus, excludeServers) {
    const paths = Array.isArray(this.config.mcpConfig) ? this.config.mcpConfig.slice() : this.config.mcpConfig ? [this.config.mcpConfig] : [];
    let bridgedHash = null;
    let allEnabledServerNames = [];
    if (this.config.bridgeOpencodeMcp !== false) {
      const bridged = bridgeOpencodeMcp(cwd, runtimeStatus, excludeServers);
      if (bridged) {
        if (bridged.path) paths.push(bridged.path);
        bridgedHash = bridged.hash;
        allEnabledServerNames = bridged.allEnabledServerNames;
      }
    }
    if (proxyConfigPath) paths.push(proxyConfigPath);
    return { paths, bridgedHash, allEnabledServerNames };
  }
  /** Resolve ProxyToolDef[] for the configured proxyTools names. */
  resolvedProxyTools() {
    const names = this.config.proxyTools;
    if (!names || names.length === 0) return null;
    const defsByName = new Map(
      DEFAULT_PROXY_TOOLS.map((t) => [t.name.toLowerCase(), t])
    );
    const picked = [];
    const seen = /* @__PURE__ */ new Set();
    for (const n of names) {
      const def = defsByName.get(String(n).toLowerCase());
      if (def && !seen.has(def.name)) {
        picked.push(def);
        seen.add(def.name);
      }
      if (def?.name === "task") {
        const batch = defsByName.get(TASK_BATCH_TOOL_NAME);
        if (batch && !seen.has(batch.name)) {
          picked.push(batch);
          seen.add(batch.name);
        }
      }
    }
    return picked.length > 0 ? picked : null;
  }
  /**
   * Resolve ProxyToolDef[] for opencode's MCP-bridged tools so they go
   * through the in-process proxy instead of being bridged into Claude CLI's
   * `--mcp-config`. Direct bridging causes double execution because both
   * Claude CLI's own MCP child and opencode hold their own connection to
   * the same server; routing through the proxy keeps a single execution
   * site (opencode). Returns null when the feature is disabled, the SDK
   * client is unavailable, or no MCP servers are configured.
   */
  async resolvedProxyMcpTools(allEnabledServerNames) {
    if (this.config.proxyOpencodeMcpTools === false) return null;
    if (this.config.bridgeOpencodeMcp === false) return null;
    if (allEnabledServerNames.length === 0) return null;
    const items = await fetchOpencodeToolList(
      this.config.provider,
      this.modelId,
      this.config.cwd
    );
    if (!items || items.length === 0) return null;
    const serversByLengthDesc = [...allEnabledServerNames].sort(
      (a, b) => b.length - a.length
    );
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const item of items) {
      const matchedServer = serversByLengthDesc.find(
        (name) => item.id === name || item.id.startsWith(`${name}_`)
      );
      if (!matchedServer) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({
        name: item.id,
        description: item.description ?? "",
        inputSchema: item.parameters && typeof item.parameters === "object" ? item.parameters : { type: "object", properties: {} }
      });
    }
    return out.length > 0 ? out : null;
  }
  /**
   * Live tool info derived from a single `client.tool.list()` fetch:
   *
   * - `taskDescription`: opencode's `task` tool description exactly as the
   *   registry renders it for native models, including the "Available
   *   agent types" list. Overlaid onto the static `task` proxy def so
   *   Claude sees the same subagent catalog native models see, instead
   *   of hunting through config files.
   * - `questionDescription` / `hasQuestion`: opencode's `question` tool
   *   description and whether the registry has the entry at all. Older
   *   builds lack it, in which case a `mcp__opencode_proxy__question`
   *   call resolves to `⚙ invalid`; the version gate drops the def.
   *
   * Returns undefined/false when the SDK client is unavailable (direct
   * AI-SDK use, tests) so the static defs stand.
   */
  async fetchLiveToolInfo() {
    const items = await fetchOpencodeToolList(
      this.config.provider,
      this.modelId,
      this.config.cwd
    );
    const question = items?.find((item) => item.id === "question");
    return {
      taskDescription: items?.find((item) => item.id === "task")?.description,
      questionDescription: question?.description,
      hasQuestion: !!question
    };
  }
  /**
   * Create a proxy MCP server for a single active Claude process/session.
   * The process lifecycle owns the server lifecycle via session-manager.
   */
  async ensureProxyServer(tools, sessionKeyForCalls) {
    const timeoutOverrides = this.config.proxyToolTimeoutMs;
    const srv = await createProxyMcpServer(tools, timeoutOverrides);
    srv.calls.on("call", (call) => {
      queuePendingProxyCall(sessionKeyForCalls, call, timeoutOverrides);
    });
    srv.calls.on("cancel", ({ id, toolName }) => {
      rejectPendingProxyCallById(
        id,
        new Error(`${CLIENT_GONE_MESSAGE}: ${toolName}`)
      );
    });
    return srv;
  }
  extractToolResult(prompt, toolCallId) {
    for (let i = prompt.length - 1; i >= 0; i--) {
      const msg = prompt[i];
      if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if (part.type !== "tool-result" || part.toolCallId !== toolCallId) continue;
        const output = part.output;
        if (!output || typeof output !== "object") {
          return {
            kind: "text",
            text: String(output ?? "")
          };
        }
        if (output.type === "text") {
          return {
            kind: "text",
            text: String(output.value ?? "")
          };
        }
        if (output.type === "error-text") {
          return {
            kind: "error",
            message: String(output.value ?? "Tool execution failed")
          };
        }
        if (output.type === "error-json") {
          return {
            kind: "error",
            message: JSON.stringify(output.value)
          };
        }
        if (output.type === "json") {
          return {
            kind: "text",
            text: JSON.stringify(output.value)
          };
        }
        if (output.type === "content" && Array.isArray(output.value)) {
          const text = output.value.filter((v) => v?.type === "text" && typeof v.text === "string").map((v) => v.text).join("\n");
          return {
            kind: "text",
            text
          };
        }
        return {
          kind: "text",
          text: JSON.stringify(output)
        };
      }
    }
    return null;
  }
  extractPendingProxyResult(prompt, call) {
    if (call.toolName !== TASK_BATCH_TOOL_NAME) {
      return this.extractToolResult(prompt, call.toolCallId);
    }
    const tasks = taskBatchTasks(call.input);
    if (tasks.length === 0) {
      return {
        kind: "error",
        message: "task_batch requires at least one valid task object"
      };
    }
    const results = tasks.map((task, index) => ({
      task,
      result: this.extractToolResult(
        prompt,
        taskBatchChildToolCallId(call.toolCallId, index)
      )
    }));
    const completedCount = results.filter(({ result }) => result !== null).length;
    if (completedCount === 0) return null;
    if (completedCount !== results.length) {
      return {
        kind: "error",
        message: `task_batch received ${completedCount} of ${results.length} child results in one provider turn; OpenCode must settle every task in the shared tool boundary before returning results`
      };
    }
    return {
      kind: "text",
      text: JSON.stringify(
        {
          results: results.map(({ task, result }, index) => ({
            index,
            description: String(task.description ?? `Task ${index + 1}`),
            isError: result.kind === "error" || result.isError === true,
            output: result.kind === "error" ? result.message : result.text
          }))
        },
        null,
        2
      )
    };
  }
  wasPendingProxyCallEmitted(prompt, call) {
    const toolCallIds = call.toolName === TASK_BATCH_TOOL_NAME ? taskBatchTasks(call.input).map(
      (_, index) => taskBatchChildToolCallId(call.toolCallId, index)
    ) : [call.toolCallId];
    return prompt.some(
      (message) => message.role === "assistant" && Array.isArray(message.content) && message.content.some(
        (part) => part.type === "tool-call" && toolCallIds.includes(part.toolCallId)
      )
    );
  }
  /**
   * Resolve the session affinity token for this LLM call. Delegates to the
   * exported `resolveSessionAffinity` helper so the logic is unit-testable.
   * Priority:
   *   1. `x-session-affinity` request header (primary).
   *   2. `opencodeSessionID` in providerOptions (chat.params hook fallback —
   *      covers provider switches mid-session and title synthesis paths
   *      where the header is absent).
   *   3. `"default"`.
   */
  sessionAffinity(options) {
    const headers = options?.headers;
    return resolveSessionAffinity(
      headers,
      options.providerOptions,
      this.config.provider
    );
  }
  controlRequestBehaviorForTool(toolName) {
    const configured = this.config.controlRequestToolBehaviors;
    if (configured && toolName) {
      const direct = configured[toolName] ?? configured[toolName.toLowerCase()];
      if (direct === "allow" || direct === "deny") return direct;
      const lower = toolName.toLowerCase();
      for (const [key, behavior] of Object.entries(configured)) {
        if (key.toLowerCase() === lower && (behavior === "allow" || behavior === "deny")) {
          return behavior;
        }
      }
    }
    if (isAskUserQuestionTool(toolName)) return "deny";
    return this.config.controlRequestBehavior ?? "allow";
  }
  writeControlResponse(proc, requestId, response) {
    const payload = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response
      }
    };
    try {
      proc.stdin?.write(JSON.stringify(payload) + "\n");
    } catch (error) {
      log.warn("failed to write control response", {
        requestId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  /**
   * Handle Claude stream-json control requests (`can_use_tool`, etc.) and
   * respond via stdin with a matching `control_response`.
   */
  handleControlRequest(msg, proc) {
    if (msg.type !== "control_request") return false;
    const requestId = msg.request_id;
    const request = msg.request;
    if (!requestId || !request?.subtype) return false;
    if (request.subtype === "can_use_tool") {
      const toolName = request.tool_name ?? "unknown";
      const behavior = this.controlRequestBehaviorForTool(toolName);
      if (behavior === "allow") {
        this.writeControlResponse(proc, requestId, {
          behavior: "allow",
          updatedInput: request.input ?? {},
          toolUseID: request.tool_use_id
        });
        log.info("control request auto-allowed", {
          requestId,
          toolName
        });
      } else {
        const denyMessage = denyMessageForTool(
          toolName,
          this.config.controlRequestDenyMessage
        );
        this.writeControlResponse(proc, requestId, {
          behavior: "deny",
          message: denyMessage,
          toolUseID: request.tool_use_id
        });
        log.info("control request auto-denied", {
          requestId,
          toolName
        });
      }
      return true;
    }
    this.writeControlResponse(proc, requestId, {});
    log.debug("control request acknowledged", {
      requestId,
      subtype: request.subtype
    });
    return true;
  }
  getReasoningEffort(providerOptions) {
    if (!providerOptions) return void 0;
    const ownKey = this.config.provider;
    const bag = providerOptions[ownKey] ?? providerOptions["claude-code"];
    const effort = bag?.reasoningEffort;
    const valid = [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ];
    return valid.includes(effort) ? effort : void 0;
  }
  getOpencodeAgent(providerOptions) {
    if (!providerOptions) return void 0;
    const ownKey = this.config.provider;
    const bag = providerOptions[ownKey] ?? providerOptions["claude-code"];
    const agent = bag?.opencodeAgent;
    return typeof agent === "string" ? agent : void 0;
  }
  isCompactionCall(options) {
    return this.getOpencodeAgent(options.providerOptions) === "compaction";
  }
  /**
   * Pick the model used to handle /compact. Precedence:
   *   1. `CLAUDE_CODE_COMPACTION_MODEL` env var (per-process override)
   *   2. `compactionModel` provider setting (opencode.json / .jsonc)
   *   3. Built-in default (claude-haiku-4-5)
   */
  resolveCompactionModel() {
    return resolveCompactionModel(this.config.compactionModel);
  }
  thinkingCliOptions() {
    if (isClaudeThinkingDisabled()) return {};
    return {
      thinking: "enabled",
      thinkingDisplay: process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES === void 0 ? "summarized" : void 0
    };
  }
  latestUserText(prompt) {
    for (let i = prompt.length - 1; i >= 0; i--) {
      const msg = prompt[i];
      if (msg.role !== "user") continue;
      if (typeof msg.content === "string") {
        return String(msg.content).trim();
      }
      if (Array.isArray(msg.content)) {
        const text = msg.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => String(part.text).trim()).filter(Boolean).join(" ");
        if (text) return text;
      }
    }
    return "";
  }
  synthesizeTitle(prompt) {
    const source = this.latestUserText(prompt).replace(/\s+/g, " ").replace(/[^\p{L}\p{N}\s-]/gu, " ").trim();
    if (!source) return "New Session";
    const stop = /* @__PURE__ */ new Set([
      "a",
      "an",
      "the",
      "and",
      "or",
      "but",
      "to",
      "for",
      "of",
      "in",
      "on",
      "at",
      "with",
      "can",
      "could",
      "would",
      "should",
      "please",
      "hi",
      "hello",
      "hey",
      "there",
      "you",
      "your",
      "this",
      "that",
      "is",
      "are",
      "was",
      "were",
      "be",
      "do",
      "does",
      "did",
      "summarize",
      "summary",
      "project"
    ]);
    const words = source.split(" ").map((word) => word.trim()).filter(Boolean).filter((word) => !stop.has(word.toLowerCase()));
    const picked = (words.length > 0 ? words : source.split(" ").filter(Boolean)).slice(0, 6).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
    return picked || "New Session";
  }
  async doGenerateViaStream(options) {
    const result = await this.doStream(options);
    const reader = result.stream.getReader();
    let text = "";
    let reasoning = "";
    const toolCalls = [];
    let finishReason = this.toFinishReason("stop");
    let usage = this.toUsage();
    let providerMetadata;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      switch (value.type) {
        case "text-delta":
          text += value.delta ?? "";
          break;
        case "reasoning-delta":
          reasoning += value.delta ?? "";
          break;
        case "tool-call":
          toolCalls.push({
            type: "tool-call",
            toolCallId: value.toolCallId,
            toolName: value.toolName,
            input: value.input,
            providerExecuted: value.providerExecuted
          });
          break;
        case "finish":
          finishReason = value.finishReason ?? finishReason;
          usage = value.usage ?? usage;
          providerMetadata = value.providerMetadata ?? providerMetadata;
          break;
      }
    }
    const content = [];
    if (reasoning) {
      content.push({ type: "reasoning", text: reasoning });
    }
    if (text) {
      content.push({ type: "text", text, providerMetadata });
    }
    content.push(...toolCalls);
    return {
      content,
      finishReason,
      usage,
      request: result.request,
      response: {
        id: generateId(),
        timestamp: /* @__PURE__ */ new Date(),
        modelId: this.modelId
      },
      providerMetadata,
      warnings: []
    };
  }
  async doGenerate(options) {
    const warnings = [];
    const cwd = resolveSpawnCwd(this.config.cwd);
    const scope = this.requestScope(options);
    const affinity = this.sessionAffinity(options);
    const sk = sessionKey(cwd, `${this.modelId}::${scope}::${affinity}`);
    const compactionMode = this.isCompactionCall(options);
    if (scope === "tools" && (this.resolvedProxyTools() || this.config.proxyOpencodeMcpTools !== false && this.config.bridgeOpencodeMcp !== false)) {
      return this.doGenerateViaStream(options);
    }
    if (compactionMode) {
      return this.doGenerateViaStream(options);
    }
    if (scope === "no-tools") {
      log.info("doGenerate no-tools title stub", {
        compactionMode,
        opencodeAgent: this.getOpencodeAgent(options.providerOptions),
        providerOptionsKeys: options.providerOptions ? Object.keys(options.providerOptions) : []
      });
      const text = this.synthesizeTitle(options.prompt);
      return {
        content: [{ type: "text", text }],
        finishReason: this.toFinishReason("stop"),
        usage: this.toUsage({ input_tokens: 0, output_tokens: 0 }),
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: /* @__PURE__ */ new Date(),
          modelId: this.modelId
        },
        providerMetadata: {
          "claude-code": {
            synthetic: true,
            path: "no-tools"
          }
        },
        warnings
      };
    }
    if (!hasNewUserContent(options.prompt)) {
      log.info("doGenerate short-circuit: no new user content");
      return {
        content: [],
        finishReason: this.toFinishReason("stop"),
        usage: this.toUsage({ input_tokens: 0, output_tokens: 0 }),
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: /* @__PURE__ */ new Date(),
          modelId: this.modelId
        },
        providerMetadata: {
          "claude-code": { synthetic: true, path: "no-new-user-content" }
        },
        warnings
      };
    }
    const hasPriorConversation = options.prompt.filter((m) => m.role === "user" || m.role === "assistant").length > 1;
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk);
      deleteActiveProcess(sk);
    }
    const hasExistingSession = !!getClaudeSessionId(sk);
    const includeHistoryContext = !hasExistingSession && hasPriorConversation;
    const reasoningEffort = this.getReasoningEffort(options.providerOptions);
    const userMsg = getClaudeUserMessage(
      options.prompt,
      includeHistoryContext,
      reasoningEffort
    );
    const [runtimeStatus, cliVersion, skillPluginDirs] = await Promise.all([
      getRuntimeMcpStatus(),
      detectCliVersion(this.config.cliPath),
      resolveSkillPluginDirs({
        cwd,
        cliPath: this.config.cliPath,
        enabled: this.config.bridgeOpencodeSkills !== false
      })
    ]);
    const systemPromptFile = buildAppendedSystemPrompt(
      cwd,
      this.config.multiStepContinuation !== false,
      extractSystemMessages(options.prompt)
    );
    const cliArgs = buildCliArgs({
      sessionKey: sk,
      skipPermissions: this.config.skipPermissions !== false,
      includeSessionId: false,
      model: this.modelId,
      permissionMode: this.config.permissionMode,
      mcpConfig: this.effectiveMcpConfig(cwd, void 0, runtimeStatus).paths,
      strictMcpConfig: this.config.strictMcpConfig,
      pluginDirs: skillPluginDirs,
      disallowedTools: this.config.webSearch === "disabled" ? ["WebSearch"] : void 0,
      appendSystemPromptFile: systemPromptFile,
      ...this.thinkingCliOptions(),
      cliVersion
    });
    log.info("doGenerate starting", {
      cwd,
      model: this.modelId,
      textLength: userMsg.length,
      includeHistoryContext
    });
    const { spawn: spawn2 } = await import("child_process");
    const { createInterface: createInterface2 } = await import("readline");
    const proc = spawn2(this.config.cliPath, cliArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: claudeSpawnEnv({
        ignoreAnthropicApiKey: this.config.ignoreAnthropicApiKey
      }),
      shell: process.platform === "win32"
    });
    if (systemPromptFile) {
      proc.on("exit", () => {
        void unlink3(systemPromptFile).catch(() => {
        });
      });
    }
    const rl = createInterface2({ input: proc.stdout });
    let responseText = "";
    let thinkingText = "";
    let resultMeta = {};
    const toolCalls = [];
    const toolCallStreams = /* @__PURE__ */ new Map();
    let gotPartialEvents = false;
    const result = await new Promise((resolve5, reject) => {
      const cleanup = () => {
        try {
          if (!proc.killed && proc.exitCode === null) proc.kill();
        } catch {
        }
      };
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const outer = JSON.parse(line);
          const msg = outer.type === "stream_event" && outer.event ? { ...outer.event, session_id: outer.session_id } : outer;
          if (outer.type === "stream_event") {
            gotPartialEvents = true;
          }
          if (this.handleControlRequest(msg, proc)) {
            return;
          }
          if (msg.type === "system" && msg.subtype === "init") {
            if (msg.session_id) {
              setClaudeSessionId(sk, msg.session_id);
            }
          }
          if (msg.type === "assistant" && msg.message?.content && !gotPartialEvents) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                responseText += block.text;
              }
              if (block.type === "thinking" && block.thinking) {
                thinkingText += block.thinking;
              }
              if (block.type === "tool_use" && block.id && block.name) {
                if (isAskUserQuestionTool(block.name)) {
                  const parsedInput = block.input ?? {};
                  responseText += formatAskUserQuestion(parsedInput);
                  continue;
                }
                if (block.name === "ExitPlanMode") {
                  const parsedInput = block.input ?? {};
                  const plan = parsedInput?.plan || "";
                  responseText += `

${plan}

---
**Do you want to proceed with this plan?** (yes/no)
`;
                  continue;
                }
                toolCalls.push({
                  id: block.id,
                  name: block.name,
                  args: block.input ?? {}
                });
              }
            }
          }
          if (msg.type === "content_block_start" && msg.content_block && msg.index !== void 0) {
            if (msg.content_block.type === "tool_use" && msg.content_block.id && msg.content_block.name) {
              toolCallStreams.set(msg.index, {
                id: msg.content_block.id,
                name: msg.content_block.name,
                inputJson: ""
              });
            }
          }
          if (msg.type === "content_block_delta" && msg.delta && msg.index !== void 0) {
            if (msg.delta.type === "text_delta" && msg.delta.text) {
              responseText += msg.delta.text;
            }
            if (msg.delta.type === "thinking_delta" && msg.delta.thinking) {
              thinkingText += msg.delta.thinking;
            }
            if (msg.delta.type === "input_json_delta" && msg.delta.partial_json) {
              const tc = toolCallStreams.get(msg.index);
              if (tc) tc.inputJson += msg.delta.partial_json;
            }
          }
          if (msg.type === "content_block_stop" && msg.index !== void 0) {
            const tc = toolCallStreams.get(msg.index);
            if (tc) {
              let args = {};
              try {
                args = tc.inputJson ? JSON.parse(tc.inputJson) : {};
              } catch (err) {
                log.warn("tool input JSON parse failed", {
                  name: tc.name,
                  error: String(err)
                });
              }
              toolCalls.push({ id: tc.id, name: tc.name, args });
              toolCallStreams.delete(msg.index);
            }
          }
          if (msg.type === "result") {
            if (msg.session_id) {
              setClaudeSessionId(sk, msg.session_id);
            }
            if (!responseText && msg.is_error && typeof msg.result === "string" && msg.result.trim().length > 0) {
              responseText = msg.result;
            }
            resultMeta = {
              sessionId: msg.session_id,
              costUsd: msg.total_cost_usd,
              durationMs: msg.duration_ms,
              usage: msg.usage
            };
            cleanup();
            resolve5({
              ...resultMeta,
              text: responseText,
              thinking: thinkingText,
              toolCalls
            });
          }
        } catch {
        }
      });
      rl.on("close", () => {
        cleanup();
        resolve5({
          ...resultMeta,
          text: responseText,
          thinking: thinkingText,
          toolCalls
        });
      });
      proc.on("error", (err) => {
        log.error("process error", { error: err.message });
        cleanup();
        reject(err);
      });
      proc.stderr?.on("data", (data) => {
        log.debug("stderr", { data: data.toString().slice(0, 200) });
      });
      proc.stdin?.write(userMsg + "\n");
    });
    const content = [];
    if (result.thinking) {
      content.push({
        type: "reasoning",
        text: result.thinking
      });
    }
    if (result.text) {
      content.push({
        type: "text",
        text: result.text,
        providerMetadata: {
          "claude-code": {
            sessionId: result.sessionId ?? null,
            costUsd: result.costUsd ?? null,
            durationMs: result.durationMs ?? null
          },
          ...typeof result.usage?.cache_creation_input_tokens === "number" ? {
            anthropic: {
              cacheCreationInputTokens: result.usage.cache_creation_input_tokens
            }
          } : {}
        }
      });
    }
    for (const tc of result.toolCalls) {
      const {
        name: mappedName,
        input: mappedInput,
        executed,
        skip
      } = mapTool(tc.name, tc.args, {
        webSearch: this.config.webSearch,
        sessionId: getClaudeSessionId(sk),
        toolUseId: tc.id
      });
      if (skip) continue;
      content.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: mappedName,
        input: JSON.stringify(mappedInput),
        providerExecuted: executed
      });
    }
    const usage = this.toUsage(result.usage);
    return {
      content,
      // Claude CLI's `result` message signals a fully-completed turn —
      // tools have already been executed internally and final assistant
      // text has been produced. Always report "stop" so opencode doesn't
      // loop expecting to run tools itself.
      finishReason: this.toFinishReason("stop"),
      usage,
      request: { body: { text: userMsg } },
      response: {
        id: result.sessionId ?? generateId(),
        timestamp: /* @__PURE__ */ new Date(),
        modelId: this.modelId
      },
      providerMetadata: {
        "claude-code": {
          sessionId: result.sessionId ?? null,
          costUsd: result.costUsd ?? null,
          durationMs: result.durationMs ?? null
        },
        ...typeof result.usage?.cache_creation_input_tokens === "number" ? {
          anthropic: {
            cacheCreationInputTokens: result.usage.cache_creation_input_tokens
          }
        } : {}
      },
      warnings
    };
  }
  async doStream(options) {
    const warnings = [];
    const cwd = resolveSpawnCwd(this.config.cwd);
    const cliPath = this.config.cliPath;
    const skipPermissions = this.config.skipPermissions !== false;
    const scope = this.requestScope(options);
    const affinity = this.sessionAffinity(options);
    const compactionMode = this.isCompactionCall(options);
    const effectiveModelId = compactionMode ? this.resolveCompactionModel() : this.modelId;
    const sk = compactionMode ? sessionKey(cwd, `${effectiveModelId}::compaction::${affinity}`) : sessionKey(cwd, `${this.modelId}::${scope}::${affinity}`);
    const toUsage = this.toUsage.bind(this);
    const toFinishReason = this.toFinishReason.bind(this);
    const handleControlRequest = this.handleControlRequest.bind(this);
    const flagOn = (v) => v !== void 0 && !["", "0", "false", "no", "off"].includes(v.trim().toLowerCase());
    const interactivePref = this.config.interactive ?? flagOn(process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT);
    const useInteractive = interactivePref && typeof globalThis.Bun?.Terminal === "function";
    const interactiveBypassRequested = this.config.interactiveBypass ?? flagOn(process.env.CLAUDE_CODE_INTERACTIVE_BYPASS);
    if (scope === "no-tools" && !compactionMode) {
      log.info("doStream no-tools title stub", {
        compactionMode,
        opencodeAgent: this.getOpencodeAgent(options.providerOptions),
        providerOptionsKeys: options.providerOptions ? Object.keys(options.providerOptions) : []
      });
      const text = this.synthesizeTitle(options.prompt);
      const textId = generateId();
      const stream2 = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
          controller.enqueue({ type: "text-start", id: textId });
          controller.enqueue({
            type: "text-delta",
            id: textId,
            delta: text
          });
          controller.enqueue({ type: "text-end", id: textId });
          controller.enqueue({
            type: "finish",
            finishReason: toFinishReason("stop"),
            usage: toUsage({ input_tokens: 0, output_tokens: 0 }),
            providerMetadata: {
              "claude-code": {
                synthetic: true,
                path: "no-tools"
              }
            }
          });
          controller.close();
        }
      });
      return {
        stream: stream2,
        request: { body: { text: "" } }
      };
    }
    if (!hasNewUserContent(options.prompt)) {
      log.info("doStream short-circuit: no new user content");
      const stream2 = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
          controller.enqueue({
            type: "finish",
            finishReason: toFinishReason("stop"),
            usage: toUsage({ input_tokens: 0, output_tokens: 0 }),
            providerMetadata: {
              "claude-code": { synthetic: true, path: "no-new-user-content" }
            }
          });
          controller.close();
        }
      });
      return { stream: stream2, request: { body: { text: "" } } };
    }
    const hasPriorConversation = options.prompt.filter((m) => m.role === "user" || m.role === "assistant").length > 1;
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk);
      deleteActiveProcess(sk);
    }
    const hasExistingSession = !!getClaudeSessionId(sk);
    const hasActiveProcess = !!getActiveProcess(sk);
    const includeHistoryContext = !hasExistingSession && !hasActiveProcess && hasPriorConversation;
    const reasoningEffort = this.getReasoningEffort(options.providerOptions);
    const userMsg = getClaudeUserMessage(
      options.prompt,
      includeHistoryContext,
      reasoningEffort,
      { compactionMode }
    );
    const resolvedProxy = compactionMode ? null : this.resolvedProxyTools();
    const self = this;
    const previousPendingProxyCalls = compactionMode ? [] : getPendingProxyCalls(sk);
    const previousPendingProxyMatches = previousPendingProxyCalls.map((call) => ({
      call,
      result: this.extractPendingProxyResult(options.prompt, call)
    }));
    const hasMatchedPendingResults = previousPendingProxyMatches.some(
      (m) => m.result !== null
    );
    const [runtimeStatus, cliVersion, skillPluginDirs] = await Promise.all([
      compactionMode ? Promise.resolve(void 0) : getRuntimeMcpStatus(),
      detectCliVersion(this.config.cliPath),
      compactionMode ? Promise.resolve([]) : resolveSkillPluginDirs({
        cwd,
        cliPath: this.config.cliPath,
        enabled: this.config.bridgeOpencodeSkills !== false
      })
    ]);
    log.info("doStream starting", {
      cwd,
      model: effectiveModelId,
      textLength: userMsg.length,
      includeHistoryContext,
      hasActiveProcess,
      reasoningEffort,
      proxyTools: resolvedProxy?.map((t) => t.name) ?? null,
      compactionMode,
      scope,
      opencodeAgent: this.getOpencodeAgent(options.providerOptions),
      providerOptionsKeys: options.providerOptions ? Object.keys(options.providerOptions) : []
    });
    const stream = new ReadableStream({
      start(controller) {
        if (compactionMode) {
          deleteActiveProcess(sk);
          deleteClaudeSessionId(sk);
        }
        let activeProcess = getActiveProcess(sk);
        let proc;
        let lineEmitter;
        let cliArgs;
        let proxyServer = activeProcess?.proxyServer ?? null;
        const setup = async () => {
          if (!compactionMode && activeProcess && self.config.hotReloadMcp !== false && self.config.bridgeOpencodeMcp !== false) {
            const probe = self.effectiveMcpConfig(cwd, void 0, runtimeStatus);
            const previousHash = activeProcess.mcpHash ?? null;
            if (previousHash !== probe.bridgedHash) {
              if (previousPendingProxyCalls.length > 0) {
                log.info("deferring MCP hot reload until proxy calls resolve", {
                  sk,
                  previousHash,
                  currentHash: probe.bridgedHash,
                  pendingCalls: previousPendingProxyCalls.length
                });
              } else {
                log.info("opencode MCP config changed, respawning claude", {
                  sk,
                  previousHash,
                  currentHash: probe.bridgedHash
                });
                await deleteActiveProcessAndWait(sk);
                activeProcess = void 0;
                proxyServer = null;
              }
            }
          }
          if (useInteractive && !compactionMode) {
            const mcp = self.effectiveMcpConfig(cwd, void 0, runtimeStatus);
            if (activeProcess) {
              proc = activeProcess.proc;
              lineEmitter = activeProcess.lineEmitter;
              log.debug("reusing active interactive session", { sk });
            } else {
              const allow = [
                ...mcp.allEnabledServerNames.map((n) => `mcp__${n}__*`),
                "mcp__opencode_proxy__*",
                ...self.config.interactiveAllowTools ?? [
                  "Bash",
                  "Edit",
                  "Write",
                  "Read",
                  "WebFetch"
                ]
              ];
              const systemPromptFile = self.config.interactiveSystemPrompt === false ? void 0 : buildAppendedSystemPrompt(
                cwd,
                self.config.multiStepContinuation !== false,
                // Do not forward opencode's own system prompt into the
                // interactive TUI. Live subscription-account testing
                // showed that large forwarded payload can trigger Claude
                // Code's third-party-app usage gate, while our static
                // CLI/AGENTS/continuation prompt remains safe.
                [],
                resolvedProxy?.some(
                  (tool) => tool.name === TASK_BATCH_TOOL_NAME
                ) === true
              );
              if (self.config.interactiveSystemPrompt === false) {
                log.warn(
                  "interactive system prompt disabled; opencode agent prompts will not be appended"
                );
              }
              if (interactiveBypassRequested) {
                log.warn(
                  "interactiveBypass ignored: Claude Code prompts for bypassPermissions confirmation in the interactive TUI"
                );
              }
              const ap = spawnInteractiveProcess({
                cwd,
                cliPath,
                configDir: self.config.configDir,
                model: effectiveModelId,
                mcpConfigPaths: mcp.paths,
                pluginDirs: skillPluginDirs,
                permissionsAllow: allow,
                systemPromptFile,
                ignoreAnthropicApiKey: self.config.ignoreAnthropicApiKey
              });
              ap.mcpHash = mcp.bridgedHash;
              setActiveProcess(sk, ap);
              proc = ap.proc;
              lineEmitter = ap.lineEmitter;
              activeProcess = ap;
              log.info("spawned interactive claude session", {
                sk,
                cliPath,
                configDir: self.config.configDir,
                model: effectiveModelId
              });
            }
          } else {
            let spawnSystemPromptFile;
            let spawnProxyServer = null;
            let spawnMcpHash = null;
            if (compactionMode) {
              cliArgs = buildCliArgs({
                sessionKey: sk,
                skipPermissions,
                includeSessionId: false,
                model: effectiveModelId,
                permissionMode: self.config.permissionMode,
                cliVersion
              });
            } else {
              const discovery = self.effectiveMcpConfig(
                cwd,
                void 0,
                runtimeStatus
              );
              const proxyMcpTools = await self.resolvedProxyMcpTools(
                discovery.allEnabledServerNames
              );
              const excludeServers = proxyMcpTools ? new Set(discovery.allEnabledServerNames) : void 0;
              const taskProxyEnabled = resolvedProxy?.some((t) => t.name === "task") ?? false;
              const questionProxyEnabled = resolvedProxy?.some((t) => t.name === "question") ?? false;
              const liveToolInfo = taskProxyEnabled || questionProxyEnabled ? await self.fetchLiveToolInfo() : {
                taskDescription: void 0,
                questionDescription: void 0,
                hasQuestion: false
              };
              let enrichedProxy = resolvedProxy;
              if (enrichedProxy && taskProxyEnabled) {
                enrichedProxy = overlayTaskProxyDescription(
                  enrichedProxy,
                  liveToolInfo.taskDescription
                );
                log.info("task proxy description overlay", {
                  applied: Boolean(liveToolInfo.taskDescription),
                  liveDescriptionLength: liveToolInfo.taskDescription?.length ?? 0,
                  listsAgentTypes: Boolean(
                    liveToolInfo.taskDescription?.includes(
                      "Available agent types"
                    )
                  )
                });
              }
              if (enrichedProxy && questionProxyEnabled) {
                enrichedProxy = overlayQuestionProxyDescription(
                  enrichedProxy,
                  liveToolInfo.hasQuestion ? liveToolInfo.questionDescription : void 0
                );
                enrichedProxy = filterQuestionProxyByOpencodeSupport(
                  enrichedProxy,
                  liveToolInfo.hasQuestion
                );
                log.info("question proxy version gate", {
                  opencodeHasQuestion: liveToolInfo.hasQuestion,
                  kept: liveToolInfo.hasQuestion
                });
              }
              const combinedList = [
                ...enrichedProxy ?? [],
                ...proxyMcpTools ?? []
              ];
              const combinedProxyTools = combinedList.length > 0 ? combinedList : null;
              if (!proxyServer && combinedProxyTools) {
                proxyServer = await self.ensureProxyServer(combinedProxyTools, sk);
              }
              const questionProxyActive = enrichedProxy?.some((t) => t.name === "question") ?? false;
              const proxyDisallowed = enrichedProxy ? disallowedToolFlags(enrichedProxy) : [];
              const extraDisallowed = [];
              if (self.config.webSearch === "disabled") extraDisallowed.push("WebSearch");
              const allDisallowed = [...proxyDisallowed, ...extraDisallowed];
              const mcp = self.effectiveMcpConfig(
                cwd,
                proxyServer?.configPath(),
                runtimeStatus,
                excludeServers
              );
              const systemPromptFile = activeProcess ? void 0 : buildAppendedSystemPrompt(
                cwd,
                self.config.multiStepContinuation !== false,
                [
                  ...extractSystemMessages(options.prompt),
                  ...taskProxyEnabled ? [SUBAGENT_DISPATCH_HINT] : [],
                  ...questionProxyActive ? [QUESTION_PROXY_HINT] : []
                ],
                enrichedProxy?.some(
                  (tool) => tool.name === TASK_BATCH_TOOL_NAME
                ) === true
              );
              cliArgs = buildCliArgs({
                sessionKey: sk,
                skipPermissions,
                model: self.modelId,
                permissionMode: self.config.permissionMode,
                mcpConfig: mcp.paths,
                strictMcpConfig: self.config.strictMcpConfig,
                pluginDirs: skillPluginDirs,
                disallowedTools: allDisallowed.length > 0 ? allDisallowed : void 0,
                appendSystemPromptFile: systemPromptFile,
                ...self.thinkingCliOptions(),
                cliVersion
              });
              spawnSystemPromptFile = systemPromptFile;
              spawnProxyServer = proxyServer;
              spawnMcpHash = mcp.bridgedHash;
            }
            if (activeProcess && !compactionMode) {
              proc = activeProcess.proc;
              lineEmitter = activeProcess.lineEmitter;
              log.debug("reusing active process", { sk });
            } else {
              const ap = spawnClaudeProcess(
                cliPath,
                cliArgs,
                cwd,
                sk,
                spawnProxyServer,
                spawnMcpHash,
                spawnSystemPromptFile,
                self.config.ignoreAnthropicApiKey
              );
              proc = ap.proc;
              lineEmitter = ap.lineEmitter;
              activeProcess = ap;
            }
          }
          if (activeProcess && !hasMatchedPendingResults) {
            const busyProcess = activeProcess;
            if (isTurnInFlight(busyProcess)) {
              log.warn("previous turn still in flight; interrupting it", { sk });
              const idle = await interruptTurn(busyProcess);
              if (!idle) {
                log.warn(
                  "previous turn did not stop in time; this turn may see stale output",
                  { sk }
                );
              }
            }
          }
          controller.enqueue({ type: "stream-start", warnings });
          let currentTextId = null;
          const textBlockIndices = /* @__PURE__ */ new Set();
          const startTextBlock = () => {
            if (currentTextId) {
              controller.enqueue({ type: "text-end", id: currentTextId });
            }
            const id = generateId();
            currentTextId = id;
            controller.enqueue({ type: "text-start", id });
            return id;
          };
          const endTextBlock = () => {
            if (currentTextId) {
              controller.enqueue({ type: "text-end", id: currentTextId });
              currentTextId = null;
            }
          };
          const reasoningIds = /* @__PURE__ */ new Map();
          const reasoningStarted = /* @__PURE__ */ new Map();
          let hadThinkingTextFromStream = false;
          let turnCompleted = false;
          let controllerClosed = false;
          let pendingProxyUnsubscribe = null;
          let resultFallbackTimer = null;
          let pendingResultCompletion = null;
          let hasReceivedContent = false;
          let visibleTextSinceContinue = "";
          let lastVisibleTextSinceContinue = "";
          let hadReasoningSinceContinue = false;
          let hadToolActivitySinceContinue = false;
          let hadProxyActivitySinceContinue = false;
          let lastStopReason = null;
          const autoContinueState = {
            enabled: self.config.autoContinueIncompleteTurns,
            attempts: 0,
            startedAt: Date.now(),
            noProgressCount: 0
          };
          const clearFallbackTimer = () => {
            if (resultFallbackTimer) {
              clearTimeout(resultFallbackTimer);
              resultFallbackTimer = null;
            }
          };
          const startResultFallback = (delayMs = 6e4) => {
            clearFallbackTimer();
            if (!hasReceivedContent || controllerClosed) return;
            resultFallbackTimer = setTimeout(() => {
              if (controllerClosed) return;
              log.warn("result fallback timer fired \u2014 closing stream without result event", {
                delayMs
              });
              closeHandler();
            }, delayMs);
          };
          const START_WATCHDOG_MS = (() => {
            const env = process.env.CLAUDE_CODE_START_WATCHDOG_MS;
            const parsed = env ? Number.parseInt(env, 10) : NaN;
            return Number.isFinite(parsed) && parsed > 0 ? parsed : 9e4;
          })();
          let startWatchdog = null;
          let respawnAttempted = false;
          const clearStartWatchdog = () => {
            if (startWatchdog) {
              clearTimeout(startWatchdog);
              startWatchdog = null;
            }
          };
          const onStartWatchdogFire = () => {
            startWatchdog = null;
            if (controllerClosed || hasReceivedContent) return;
            if (respawnAttempted) {
              log.error(
                "claude process still silent after respawn; ending turn",
                { sessionKey: sk }
              );
              deleteActiveProcess(sk);
              deleteClaudeSessionId(sk);
              controllerClosed = true;
              cleanupTurn();
              controller.enqueue({
                type: "error",
                error: new Error(
                  "Claude process produced no output after the envelope write (start watchdog timeout)."
                )
              });
              try {
                controller.close();
              } catch {
              }
              return;
            }
            respawnAttempted = true;
            log.warn(
              "no stdout after envelope write; respawning claude process to resume conversation",
              { sessionKey: sk, startWatchdogMs: START_WATCHDOG_MS }
            );
            lineEmitter.off("line", lineHandler);
            lineEmitter.off("close", closeHandler);
            proc.off("error", procErrorHandler);
            const newAp = respawnActiveProcess(
              sk,
              cliPath,
              cliArgs,
              cwd,
              self.config.ignoreAnthropicApiKey
            );
            if (!newAp) {
              log.error(
                "no active process to respawn (start watchdog); ending turn",
                { sessionKey: sk }
              );
              controllerClosed = true;
              cleanupTurn();
              controller.enqueue({
                type: "error",
                error: new Error(
                  "No active claude process to respawn after start watchdog timeout."
                )
              });
              try {
                controller.close();
              } catch {
              }
              return;
            }
            proc = newAp.proc;
            lineEmitter = newAp.lineEmitter;
            activeProcess = newAp;
            lineEmitter.on("line", lineHandler);
            lineEmitter.on("close", closeHandler);
            proc.on("error", procErrorHandler);
            try {
              proc.stdin?.write(userMsg + "\n");
              log.debug("re-sent user message after respawn", {
                textLength: userMsg.length
              });
            } catch (err) {
              log.error("failed to re-send envelope after respawn", {
                error: err instanceof Error ? err.message : String(err)
              });
            }
            startWatchdog = setTimeout(
              onStartWatchdogFire,
              START_WATCHDOG_MS
            );
          };
          const armStartWatchdog = () => {
            clearStartWatchdog();
            if (controllerClosed) return;
            startWatchdog = setTimeout(onStartWatchdogFire, START_WATCHDOG_MS);
          };
          const toolCallMap = /* @__PURE__ */ new Map();
          const skipResultForIds = /* @__PURE__ */ new Set();
          const toolCallsById = /* @__PURE__ */ new Map();
          let resultMeta = {};
          const drainBuffer = [];
          let drainTimer = null;
          const DRAIN_QUIET_MS = 100;
          const finishWithToolCalls = (calls) => {
            if (controllerClosed) return;
            if (calls.length === 0) return;
            const enqueueToolCall = (toolCallId, toolName, input) => {
              controller.enqueue({
                type: "tool-input-start",
                id: toolCallId,
                toolName
              });
              controller.enqueue({
                type: "tool-call",
                toolCallId,
                toolName,
                input: JSON.stringify(input),
                providerExecuted: false
              });
              skipResultForIds.add(toolCallId);
            };
            for (const call of calls) {
              if (call.toolName === TASK_BATCH_TOOL_NAME) {
                const tasks = taskBatchTasks(call.input);
                for (const [index, task] of tasks.entries()) {
                  enqueueToolCall(
                    taskBatchChildToolCallId(call.toolCallId, index),
                    "task",
                    task
                  );
                }
                continue;
              }
              enqueueToolCall(call.toolCallId, call.toolName, call.input);
            }
            controller.enqueue({
              type: "finish",
              finishReason: toFinishReason("tool-calls"),
              usage: toUsage(resultMeta.usage),
              providerMetadata: {
                "claude-code": resultMeta
              }
            });
            controllerClosed = true;
            cleanupTurn();
            try {
              controller.close();
            } catch {
            }
          };
          const drainNow = () => {
            if (drainTimer) {
              clearTimeout(drainTimer);
              drainTimer = null;
            }
            if (drainBuffer.length === 0) return;
            if (controllerClosed) return;
            const batch = drainBuffer.splice(0, drainBuffer.length);
            log.info("draining pending proxy calls into stream finish", {
              sessionKey: sk,
              count: batch.length,
              toolCallIds: batch.map((c) => c.toolCallId)
            });
            finishWithToolCalls(batch);
          };
          const settleResultBoundary = () => {
            drainTimer = null;
            const completeResult2 = pendingResultCompletion;
            pendingResultCompletion = null;
            if (!completeResult2 || controllerClosed) return;
            if (drainBuffer.length > 0) {
              drainNow();
              return;
            }
            completeResult2();
          };
          const scheduleResultBoundary = (completeResult2, delayMs) => {
            pendingResultCompletion = completeResult2;
            if (drainTimer) clearTimeout(drainTimer);
            drainTimer = setTimeout(settleResultBoundary, delayMs);
          };
          const noteResultBoundaryCall = () => {
            if (!pendingResultCompletion) return false;
            if (drainTimer) clearTimeout(drainTimer);
            drainTimer = setTimeout(settleResultBoundary, DRAIN_QUIET_MS);
            return true;
          };
          const noteVisibleText = (text) => {
            visibleTextSinceContinue += text;
            lastVisibleTextSinceContinue += text;
          };
          const resetLastVisibleTextBlock = () => {
            lastVisibleTextSinceContinue = "";
          };
          const noteReasoning = () => {
            hadReasoningSinceContinue = true;
          };
          const noteToolActivity = () => {
            hadToolActivitySinceContinue = true;
          };
          const noteProxyActivity = () => {
            hadProxyActivitySinceContinue = true;
          };
          const resetAutoContinueWindow = () => {
            visibleTextSinceContinue = "";
            lastVisibleTextSinceContinue = "";
            hadReasoningSinceContinue = false;
            hadToolActivitySinceContinue = false;
            hadProxyActivitySinceContinue = false;
            lastStopReason = null;
          };
          const completeResult = (msg) => {
            if (controllerClosed) return;
            if (drainBuffer.length > 0) {
              drainNow();
              return;
            }
            const pendingSiblings = getPendingProxyCalls(sk);
            if (pendingSiblings.length > 0) {
              log.info("leaving parallel proxy calls pending at result boundary", {
                sessionKey: sk,
                count: pendingSiblings.length
              });
            }
            const autoDecision = shouldAutoContinueIncompleteTurn(
              autoContinueState,
              {
                text: visibleTextSinceContinue,
                lastVisibleText: lastVisibleTextSinceContinue,
                hadReasoning: hadReasoningSinceContinue,
                hadToolActivity: hadToolActivitySinceContinue,
                hadProxyActivity: hadProxyActivitySinceContinue,
                isError: msg.is_error,
                stopReason: lastStopReason
              }
            );
            if (autoDecision.continue) {
              const signature = continuationSignature({
                text: visibleTextSinceContinue,
                lastVisibleText: lastVisibleTextSinceContinue,
                hadReasoning: hadReasoningSinceContinue,
                hadToolActivity: hadToolActivitySinceContinue,
                hadProxyActivity: hadProxyActivitySinceContinue,
                isError: msg.is_error
              });
              autoContinueState.noProgressCount = signature === autoContinueState.lastSignature ? autoContinueState.noProgressCount + 1 : 0;
              autoContinueState.lastSignature = signature;
              autoContinueState.attempts++;
              log.notice("auto-continuing incomplete claude result", {
                sessionKey: sk,
                reason: autoDecision.reason,
                attempts: autoContinueState.attempts,
                textLength: visibleTextSinceContinue.length,
                lastTextLength: lastVisibleTextSinceContinue.length,
                hadReasoning: hadReasoningSinceContinue,
                hadToolActivity: hadToolActivitySinceContinue,
                hadProxyActivity: hadProxyActivitySinceContinue
              });
              turnCompleted = false;
              resetAutoContinueWindow();
              if (activeProcess) noteTurnStarted(activeProcess);
              proc.stdin?.write(makeAutoContinueMessage() + "\n");
              return;
            }
            log.notice("auto-continuation stopped", {
              sessionKey: sk,
              reason: autoDecision.reason,
              stopReason: lastStopReason,
              attempts: autoContinueState.attempts,
              textLength: visibleTextSinceContinue.length,
              lastTextLength: lastVisibleTextSinceContinue.length,
              hadReasoning: hadReasoningSinceContinue,
              hadToolActivity: hadToolActivitySinceContinue,
              hadProxyActivity: hadProxyActivitySinceContinue
            });
            for (const [idx, reasoningId] of reasoningIds) {
              if (reasoningStarted.get(idx)) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: reasoningId
                });
              }
            }
            controller.enqueue({
              type: "finish",
              finishReason: toFinishReason("stop"),
              usage: toUsage(msg.usage),
              providerMetadata: {
                "claude-code": {
                  ...resultMeta,
                  ...compactionMode ? { compactionModel: effectiveModelId } : {}
                },
                ...typeof msg.usage?.cache_creation_input_tokens === "number" ? {
                  anthropic: {
                    cacheCreationInputTokens: msg.usage.cache_creation_input_tokens
                  }
                } : {}
              }
            });
            controllerClosed = true;
            cleanupTurn();
            try {
              controller.close();
            } catch {
            }
          };
          let gotPartialEvents = false;
          const lineHandler = (line) => {
            if (!line.trim()) return;
            if (controllerClosed) return;
            startResultFallback();
            clearStartWatchdog();
            try {
              const outer = JSON.parse(line);
              const msg = outer.type === "stream_event" && outer.event ? { ...outer.event, session_id: outer.session_id } : outer;
              if (outer.type === "stream_event") {
                gotPartialEvents = true;
              }
              if (handleControlRequest(msg, proc)) {
                return;
              }
              log.debug("stream message", {
                type: msg.type,
                subtype: msg.subtype
              });
              if (msg.type === "system" && msg.subtype === "init") {
                if (msg.session_id) {
                  setClaudeSessionId(sk, msg.session_id);
                  log.info("session initialized", {
                    claudeSessionId: msg.session_id
                  });
                }
              }
              if (msg.type === "content_block_start" && msg.content_block && msg.index !== void 0) {
                const block = msg.content_block;
                const idx = msg.index;
                if (block.type === "thinking") {
                  noteReasoning();
                  const reasoningId = generateId();
                  reasoningIds.set(idx, reasoningId);
                }
                if (block.type === "text") {
                  textBlockIndices.add(idx);
                  resetLastVisibleTextBlock();
                  if (block.text) {
                    if (!currentTextId) startTextBlock();
                    controller.enqueue({
                      type: "text-delta",
                      id: currentTextId,
                      delta: block.text
                    });
                    noteVisibleText(block.text);
                    hasReceivedContent = true;
                  }
                }
                if (block.type === "tool_use" && block.id && block.name) {
                  noteToolActivity();
                  const entry = {
                    id: block.id,
                    name: block.name,
                    inputJson: "",
                    started: false
                  };
                  toolCallMap.set(idx, entry);
                  if (block.name !== "AskUserQuestion" && block.name !== "ask_user_question" && block.name !== "ExitPlanMode" && !block.name.startsWith(PROXY_TOOL_PREFIX)) {
                    const { name: mappedName, skip, executed } = mapTool(
                      block.name,
                      void 0,
                      {
                        webSearch: self.config.webSearch,
                        sessionId: getClaudeSessionId(sk),
                        toolUseId: block.id
                      }
                    );
                    if (!skip) {
                      entry.started = true;
                      controller.enqueue({
                        type: "tool-input-start",
                        id: block.id,
                        toolName: mappedName,
                        providerExecuted: executed
                      });
                      log.info("tool started", {
                        name: block.name,
                        mappedName,
                        id: block.id
                      });
                    }
                  }
                }
              }
              if (msg.type === "content_block_delta" && msg.delta && msg.index !== void 0) {
                const delta = msg.delta;
                const idx = msg.index;
                if (delta.type === "thinking_delta" && delta.thinking) {
                  noteReasoning();
                  hadThinkingTextFromStream = true;
                  const reasoningId = reasoningIds.get(idx);
                  if (reasoningId) {
                    if (!reasoningStarted.get(idx)) {
                      controller.enqueue({
                        type: "reasoning-start",
                        id: reasoningId
                      });
                      reasoningStarted.set(idx, true);
                    }
                    controller.enqueue({
                      type: "reasoning-delta",
                      id: reasoningId,
                      delta: delta.thinking
                    });
                  }
                }
                if (delta.type === "text_delta" && delta.text) {
                  if (!currentTextId) startTextBlock();
                  controller.enqueue({
                    type: "text-delta",
                    id: currentTextId,
                    delta: delta.text
                  });
                  noteVisibleText(delta.text);
                  hasReceivedContent = true;
                }
                if (delta.type === "input_json_delta" && delta.partial_json) {
                  const tc = toolCallMap.get(idx);
                  if (tc) {
                    tc.inputJson += delta.partial_json;
                    if (tc.started) {
                      controller.enqueue({
                        type: "tool-input-delta",
                        id: tc.id,
                        delta: delta.partial_json
                      });
                    }
                  }
                }
                if (!KNOWN_DELTA_TYPES.has(delta.type)) {
                  log.debug("unrecognized content_block_delta type", {
                    type: delta.type,
                    idx,
                    keys: Object.keys(delta)
                  });
                }
              }
              if (msg.type === "content_block_stop" && msg.index !== void 0) {
                const idx = msg.index;
                const reasoningId = reasoningIds.get(idx);
                if (reasoningId && reasoningStarted.get(idx)) {
                  controller.enqueue({
                    type: "reasoning-end",
                    id: reasoningId
                  });
                  reasoningStarted.delete(idx);
                }
                if (textBlockIndices.has(idx)) {
                  endTextBlock();
                  textBlockIndices.delete(idx);
                }
                const tc = toolCallMap.get(idx);
                if (tc) {
                  let parsedInput = {};
                  try {
                    parsedInput = JSON.parse(tc.inputJson || "{}");
                  } catch {
                  }
                  if (isAskUserQuestionTool(tc.name)) {
                    autoContinueState.sawAskUserQuestion = true;
                    const askId = startTextBlock();
                    controller.enqueue({
                      type: "text-delta",
                      id: askId,
                      delta: formatAskUserQuestion(parsedInput)
                    });
                    endTextBlock();
                  } else if (tc.name === "ExitPlanMode") {
                    const plan = parsedInput?.plan || "";
                    const planId = startTextBlock();
                    controller.enqueue({
                      type: "text-delta",
                      id: planId,
                      delta: `

${plan}

---
**Do you want to proceed with this plan?** (yes/no)
`
                    });
                    endTextBlock();
                  } else if (isWebSearchTool(tc.name) && isWebSearchHandledByCli(self.config.webSearch)) {
                    const query = typeof parsedInput?.query === "string" ? parsedInput.query : JSON.stringify(parsedInput);
                    const searchId = startTextBlock();
                    controller.enqueue({
                      type: "text-delta",
                      id: searchId,
                      delta: `
> **Web search:** ${query}
`
                    });
                    endTextBlock();
                  } else if (tc.name.startsWith(PROXY_TOOL_PREFIX)) {
                    noteProxyActivity();
                    log.debug("ignoring proxy tool_use block; broker handles it", {
                      name: tc.name,
                      id: tc.id
                    });
                  } else {
                    const {
                      name: mappedName,
                      input: mappedInput,
                      executed,
                      skip
                    } = mapTool(tc.name, parsedInput, {
                      webSearch: self.config.webSearch,
                      sessionId: getClaudeSessionId(sk),
                      toolUseId: tc.id
                    });
                    if (!skip) {
                      toolCallsById.set(tc.id, {
                        id: tc.id,
                        name: tc.name,
                        input: parsedInput
                      });
                      if (!executed) skipResultForIds.add(tc.id);
                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: tc.id,
                        toolName: mappedName,
                        input: JSON.stringify(mappedInput),
                        providerExecuted: executed
                      });
                    }
                    log.info("tool call complete", {
                      name: tc.name,
                      mappedName,
                      id: tc.id,
                      executed
                    });
                  }
                }
              }
              if (gotPartialEvents && msg.type === "message_delta" && typeof msg.delta?.stop_reason === "string") {
                lastStopReason = msg.delta.stop_reason;
              }
              if (msg.type === "assistant" && msg.message && typeof msg.message.stop_reason === "string") {
                lastStopReason = msg.message.stop_reason;
              }
              if (msg.type === "assistant" && msg.message?.content && gotPartialEvents) {
                const thinkingBlocks = msg.message.content.filter(
                  (b) => b.type === "thinking"
                );
                if (thinkingBlocks.length > 0) {
                  log.info("assistant message thinking blocks", {
                    count: thinkingBlocks.length,
                    hasText: thinkingBlocks.some(
                      (b) => typeof b.thinking === "string" && b.thinking.length > 0
                    ),
                    hadStreamThinking: hadThinkingTextFromStream
                  });
                  if (!hadThinkingTextFromStream) {
                    for (const block of thinkingBlocks) {
                      if (block.thinking && block.thinking.length > 0) {
                        noteReasoning();
                        hadThinkingTextFromStream = true;
                        const thinkingId = generateId();
                        controller.enqueue({
                          type: "reasoning-start",
                          id: thinkingId
                        });
                        controller.enqueue({
                          type: "reasoning-delta",
                          id: thinkingId,
                          delta: block.thinking
                        });
                        controller.enqueue({
                          type: "reasoning-end",
                          id: thinkingId
                        });
                      }
                    }
                  }
                }
              }
              if (msg.type === "assistant" && msg.message?.content && !gotPartialEvents) {
                const hasText = msg.message.content.some(
                  (b) => b.type === "text" && b.text
                );
                const hasToolUse = msg.message.content.some(
                  (b) => b.type === "tool_use"
                );
                if (hasText) {
                  hasReceivedContent = true;
                }
                if (hasText && !hasToolUse) {
                  startResultFallback();
                }
                if (hasToolUse) {
                  clearFallbackTimer();
                }
                for (const block of msg.message.content) {
                  if (block.type === "text" && block.text) {
                    resetLastVisibleTextBlock();
                    const blockId = startTextBlock();
                    controller.enqueue({
                      type: "text-delta",
                      id: blockId,
                      delta: block.text
                    });
                    endTextBlock();
                    noteVisibleText(block.text);
                    hasReceivedContent = true;
                  }
                  if (block.type === "thinking" && block.thinking) {
                    noteReasoning();
                    const thinkingId = generateId();
                    controller.enqueue({
                      type: "reasoning-start",
                      id: thinkingId
                    });
                    controller.enqueue({
                      type: "reasoning-delta",
                      id: thinkingId,
                      delta: block.thinking
                    });
                    controller.enqueue({
                      type: "reasoning-end",
                      id: thinkingId
                    });
                  }
                  if (block.type === "tool_use" && block.id && block.name) {
                    noteToolActivity();
                    const parsedInput = block.input ?? {};
                    if (isAskUserQuestionTool(block.name)) {
                      const askId = startTextBlock();
                      controller.enqueue({
                        type: "text-delta",
                        id: askId,
                        delta: formatAskUserQuestion(parsedInput)
                      });
                      endTextBlock();
                    } else if (block.name === "ExitPlanMode") {
                      const plan = parsedInput?.plan || "";
                      const planId = startTextBlock();
                      controller.enqueue({
                        type: "text-delta",
                        id: planId,
                        delta: `

${plan}

---
**Do you want to proceed with this plan?** (yes/no)
`
                      });
                      endTextBlock();
                    } else if (isWebSearchTool(block.name) && isWebSearchHandledByCli(self.config.webSearch)) {
                      toolCallsById.delete(block.id);
                      const query = typeof parsedInput?.query === "string" ? parsedInput.query : JSON.stringify(parsedInput);
                      const searchId = startTextBlock();
                      controller.enqueue({
                        type: "text-delta",
                        id: searchId,
                        delta: `
> **Web search:** ${query}
`
                      });
                      endTextBlock();
                    } else if (block.name.startsWith(PROXY_TOOL_PREFIX)) {
                      noteProxyActivity();
                      log.debug("ignoring proxy tool_use from assistant message", {
                        name: block.name,
                        id: block.id
                      });
                    } else {
                      const {
                        name: mappedName,
                        input: mappedInput,
                        executed,
                        skip
                      } = mapTool(block.name, parsedInput, {
                        webSearch: self.config.webSearch,
                        sessionId: getClaudeSessionId(sk),
                        toolUseId: block.id
                      });
                      if (!skip) {
                        toolCallsById.set(block.id, {
                          id: block.id,
                          name: block.name,
                          input: parsedInput
                        });
                        if (!executed) skipResultForIds.add(block.id);
                        controller.enqueue({
                          type: "tool-input-start",
                          id: block.id,
                          toolName: mappedName,
                          providerExecuted: executed
                        });
                        controller.enqueue({
                          type: "tool-call",
                          toolCallId: block.id,
                          toolName: mappedName,
                          input: JSON.stringify(mappedInput),
                          providerExecuted: executed
                        });
                      }
                      log.info("tool_use from assistant message", {
                        name: block.name,
                        mappedName,
                        id: block.id,
                        executed
                      });
                    }
                  }
                  if (block.type === "tool_result") {
                    log.debug("tool_result", {
                      toolUseId: block.tool_use_id
                    });
                  }
                }
              }
              if (msg.type === "user" && msg.message?.content) {
                for (const block of msg.message.content) {
                  if (block.type === "tool_result" && block.tool_use_id) {
                    if (skipResultForIds.has(block.tool_use_id)) {
                      log.debug("skipping tool-result (opencode runs it)", {
                        toolUseId: block.tool_use_id
                      });
                      continue;
                    }
                    let resultText = "";
                    if (typeof block.content === "string") {
                      resultText = block.content;
                    } else if (Array.isArray(block.content)) {
                      resultText = block.content.filter(
                        (c) => c.type === "text" && typeof c.text === "string"
                      ).map((c) => c.text).join("\n");
                    }
                    const claudeSessionId = getClaudeSessionId(sk);
                    if (claudeSessionId) {
                      const list = applyTaskCreateToolResult(
                        claudeSessionId,
                        block.tool_use_id,
                        resultText
                      );
                      if (list) {
                        const synthId = `todowrite_${block.tool_use_id}`;
                        controller.enqueue({
                          type: "tool-input-start",
                          id: synthId,
                          toolName: "todowrite",
                          providerExecuted: false
                        });
                        controller.enqueue({
                          type: "tool-call",
                          toolCallId: synthId,
                          toolName: "todowrite",
                          input: JSON.stringify({
                            todos: list.map((t) => ({
                              id: t.id,
                              content: t.content,
                              status: t.status,
                              priority: "medium"
                            }))
                          }),
                          providerExecuted: false
                        });
                        noteToolActivity();
                      }
                    }
                    const toolCall = toolCallsById.get(block.tool_use_id);
                    if (toolCall) {
                      controller.enqueue({
                        type: "tool-result",
                        toolCallId: block.tool_use_id,
                        toolName: toolCall.name,
                        result: {
                          output: resultText,
                          title: toolCall.name,
                          metadata: {}
                        },
                        providerExecuted: true
                      });
                      noteToolActivity();
                      log.info("tool result emitted", {
                        toolUseId: block.tool_use_id,
                        name: toolCall.name
                      });
                      toolCallsById.delete(block.tool_use_id);
                    }
                  }
                }
              }
              if (msg.type === "result") {
                clearFallbackTimer();
                if (msg.session_id) {
                  setClaudeSessionId(sk, msg.session_id);
                }
                if (!currentTextId && msg.is_error && typeof msg.result === "string" && msg.result.trim().length > 0) {
                  const errId = startTextBlock();
                  controller.enqueue({
                    type: "text-delta",
                    id: errId,
                    delta: msg.result
                  });
                }
                resultMeta = {
                  sessionId: msg.session_id,
                  costUsd: msg.total_cost_usd,
                  durationMs: msg.duration_ms,
                  usage: msg.usage
                };
                log.info("conversation result", {
                  sessionId: msg.session_id,
                  durationMs: msg.duration_ms,
                  numTurns: msg.num_turns,
                  isError: msg.is_error
                });
                turnCompleted = true;
                endTextBlock();
                const shouldDeferResult = !msg.is_error && !autoContinueState.aborted && !autoContinueState.sawAskUserQuestion;
                if (drainBuffer.length > 0 && shouldDeferResult) {
                  log.info(
                    "waiting for parallel proxy calls at turn-result boundary",
                    {
                      sessionKey: sk,
                      count: drainBuffer.length
                    }
                  );
                  scheduleResultBoundary(
                    () => completeResult(msg),
                    DRAIN_QUIET_MS
                  );
                  return;
                }
                if (drainBuffer.length === 0 && hadProxyActivitySinceContinue && shouldDeferResult) {
                  log.info(
                    "waiting for delayed proxy call at turn-result boundary",
                    {
                      sessionKey: sk,
                      graceMs: PROXY_RESULT_BOUNDARY_GRACE_MS
                    }
                  );
                  scheduleResultBoundary(
                    () => completeResult(msg),
                    PROXY_RESULT_BOUNDARY_GRACE_MS
                  );
                  return;
                }
                completeResult(msg);
              }
            } catch (e) {
              log.debug("failed to parse line", {
                error: e instanceof Error ? e.message : String(e)
              });
            }
          };
          const closeHandler = () => {
            log.debug("readline closed");
            if (controllerClosed) return;
            if (drainBuffer.length > 0 || getPendingProxyCalls(sk).length > 0) {
              rejectAllPendingProxyCallsForSession(
                sk,
                new Error(
                  "Claude CLI subprocess closed before pending tool calls were resolved"
                )
              );
              drainBuffer.length = 0;
            }
            controllerClosed = true;
            cleanupTurn();
            endTextBlock();
            controller.enqueue({
              type: "finish",
              finishReason: toFinishReason("stop"),
              usage: toUsage(),
              providerMetadata: {
                "claude-code": {
                  ...resultMeta,
                  ...compactionMode ? { compactionModel: effectiveModelId } : {}
                }
              }
            });
            try {
              controller.close();
            } catch {
            }
          };
          let cleanedUp = false;
          const cleanupTurn = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            clearFallbackTimer();
            pendingResultCompletion = null;
            clearStartWatchdog();
            if (drainTimer) {
              clearTimeout(drainTimer);
              drainTimer = null;
            }
            lineEmitter.off("line", lineHandler);
            lineEmitter.off("close", closeHandler);
            pendingProxyUnsubscribe?.();
            pendingProxyUnsubscribe = null;
            proc.off("error", procErrorHandler);
          };
          const procErrorHandler = (err) => {
            log.error("process error", { error: err.message });
            deleteActiveProcess(sk);
            deleteClaudeSessionId(sk);
            if (controllerClosed) return;
            if (drainBuffer.length > 0 || getPendingProxyCalls(sk).length > 0) {
              rejectAllPendingProxyCallsForSession(
                sk,
                new Error(
                  `Claude CLI subprocess error: ${err.message}`
                )
              );
              drainBuffer.length = 0;
            }
            controllerClosed = true;
            cleanupTurn();
            controller.enqueue({ type: "error", error: err });
            try {
              controller.close();
            } catch {
            }
          };
          lineEmitter.on("line", lineHandler);
          lineEmitter.on("close", closeHandler);
          pendingProxyUnsubscribe = onPendingProxyCall(sk, (call) => {
            if (controllerClosed) {
              log.info(
                "pending proxy call arrived after stream close; leaving pending",
                {
                  sessionKey: sk,
                  toolCallId: call.toolCallId,
                  toolName: call.toolName
                }
              );
              return;
            }
            log.info("received pending proxy call for session", {
              sessionKey: sk,
              toolCallId: call.toolCallId,
              toolName: call.toolName
            });
            noteProxyActivity();
            noteToolActivity();
            drainBuffer.push(call);
            if (noteResultBoundaryCall()) return;
            if (drainTimer) clearTimeout(drainTimer);
            drainTimer = setTimeout(drainNow, DRAIN_QUIET_MS);
          });
          proc.on("error", procErrorHandler);
          if (options.abortSignal) {
            options.abortSignal.addEventListener("abort", () => {
              autoContinueState.aborted = true;
              if (turnCompleted || controllerClosed) return;
              if (activeProcess) {
                void interruptTurn(activeProcess).then((idle) => {
                  log.info("interrupt sent for aborted turn", { cwd, idle });
                });
              }
              if (!hasReceivedContent) {
                log.info(
                  "abort signal received before content, closing stream immediately",
                  { cwd }
                );
                if (drainBuffer.length > 0 || getPendingProxyCalls(sk).length > 0) {
                  rejectAllPendingProxyCallsForSession(
                    sk,
                    new Error(
                      "Provider stream was aborted before pending proxy calls were emitted"
                    )
                  );
                  drainBuffer.length = 0;
                }
                controllerClosed = true;
                cleanupTurn();
                try {
                  controller.close();
                } catch {
                }
                return;
              }
              log.info(
                "abort signal received mid-turn, starting grace period",
                { cwd }
              );
              startResultFallback(5e3);
            });
          }
          if (hasMatchedPendingResults) {
            for (const { call, result } of previousPendingProxyMatches) {
              if (result) {
                log.info("resolving pending proxy call from tool result prompt", {
                  sessionKey: sk,
                  toolCallId: call.toolCallId,
                  toolName: call.toolName
                });
                resolvePendingProxyCallById(call.toolCallId, result);
              }
            }
            const unreportedPendingCalls = getPendingProxyCalls(sk).filter(
              (call) => !self.wasPendingProxyCallEmitted(options.prompt, call)
            );
            if (unreportedPendingCalls.length > 0) {
              log.info(
                "surfacing proxy calls that arrived after the previous stream closed",
                {
                  sessionKey: sk,
                  toolCallIds: unreportedPendingCalls.map(
                    (call) => call.toolCallId
                  )
                }
              );
              finishWithToolCalls(unreportedPendingCalls);
            }
            return;
          }
          if (previousPendingProxyCalls.length > 0) {
            for (const call of previousPendingProxyCalls) {
              rejectPendingProxyCallById(
                call.toolCallId,
                new Error(
                  `Pending proxy call '${call.toolName}' (${call.toolCallId}) was orphaned by a new user turn; rejecting`
                )
              );
            }
          }
          if (activeProcess) noteTurnStarted(activeProcess);
          proc.stdin?.write(userMsg + "\n");
          log.debug("sent user message", { textLength: userMsg.length });
          armStartWatchdog();
        };
        void setup().catch((err) => {
          log.error("failed to set up doStream", {
            error: err instanceof Error ? err.message : String(err)
          });
          controller.enqueue({
            type: "error",
            error: err instanceof Error ? err : new Error(String(err))
          });
          try {
            controller.close();
          } catch {
          }
        });
      },
      cancel() {
      }
    });
    return {
      stream,
      request: { body: { text: userMsg } },
      response: { headers: {} }
    };
  }
};

// src/models.ts
var PROVIDER_ID = "claude-code";
var NPM = "@khalilgharbaoui/opencode-claude-code-plugin";
var reasoningVariants = {
  low: { reasoningEffort: "low" },
  medium: { reasoningEffort: "medium" },
  high: { reasoningEffort: "high" },
  xhigh: { reasoningEffort: "xhigh" },
  max: { reasoningEffort: "max" }
};
var baseCapabilities = {
  temperature: false,
  attachment: true,
  toolcall: true,
  input: { text: true, audio: false, image: true, video: false, pdf: false },
  output: { text: true, audio: false, image: false, video: false, pdf: false },
  interleaved: false
};
function defineModel(opts) {
  return {
    id: opts.id,
    providerID: PROVIDER_ID,
    api: { id: opts.id, url: "", npm: NPM },
    name: `${opts.name} (${opts.multiplier}\xD7)`,
    family: opts.family,
    capabilities: { ...baseCapabilities, reasoning: opts.reasoning },
    cost: {
      input: opts.cost.input,
      output: opts.cost.output,
      cache: { read: opts.cost.cacheRead, write: opts.cost.cacheWrite }
    },
    limit: { context: opts.context, output: opts.output },
    status: opts.status ?? "active",
    options: {},
    headers: {},
    release_date: opts.releaseDate,
    variants: opts.reasoning ? reasoningVariants : void 0
  };
}
var haikuCost = { input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheWrite: 125e-8 };
var sonnetCost = { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 375e-8 };
var opusCost = { input: 5e-6, output: 25e-6, cacheRead: 5e-7, cacheWrite: 625e-8 };
var fableCost = { input: 1e-5, output: 5e-5, cacheRead: 1e-6, cacheWrite: 125e-7 };
var fable51Cost = { ...fableCost, cacheRead: 25e-8 };
function toConfigModel(model) {
  const inputMods = [];
  const outputMods = [];
  for (const [k, v] of Object.entries(model.capabilities.input)) {
    if (v) inputMods.push(k);
  }
  for (const [k, v] of Object.entries(model.capabilities.output)) {
    if (v) outputMods.push(k);
  }
  return {
    id: model.api.id,
    name: model.name,
    status: model.status,
    family: model.family ?? "",
    release_date: model.release_date,
    temperature: model.capabilities.temperature,
    reasoning: model.capabilities.reasoning,
    attachment: model.capabilities.attachment,
    tool_call: model.capabilities.toolcall,
    modalities: { input: inputMods, output: outputMods },
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cache_read: model.cost.cache.read,
      cache_write: model.cost.cache.write
    },
    limit: model.limit,
    options: model.options,
    headers: model.headers,
    variants: model.variants
  };
}
var defaultModels = {
  "claude-haiku-4-5": defineModel({
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    family: "haiku",
    reasoning: false,
    context: 2e5,
    output: 64e3,
    cost: haikuCost,
    multiplier: 1,
    releaseDate: "2025-10-01"
  }),
  "claude-sonnet-4-5": defineModel({
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    family: "sonnet",
    reasoning: true,
    context: 2e5,
    output: 64e3,
    cost: sonnetCost,
    multiplier: 3,
    releaseDate: "2025-09-29"
  }),
  "claude-sonnet-4-6": defineModel({
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    family: "sonnet",
    reasoning: true,
    context: 1e6,
    output: 128e3,
    cost: sonnetCost,
    multiplier: 3,
    releaseDate: "2025-06-19"
  }),
  "claude-sonnet-5": defineModel({
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    family: "sonnet",
    reasoning: true,
    context: 1e6,
    output: 128e3,
    cost: sonnetCost,
    multiplier: 3,
    releaseDate: "2026-06-30"
  }),
  "claude-opus-4-5": defineModel({
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    family: "opus",
    reasoning: true,
    context: 2e5,
    output: 64e3,
    cost: opusCost,
    multiplier: 5,
    releaseDate: "2025-11-01"
  }),
  "claude-opus-4-6": defineModel({
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    family: "opus",
    reasoning: true,
    context: 1e6,
    output: 128e3,
    cost: opusCost,
    multiplier: 5,
    releaseDate: "2025-06-19"
  }),
  "claude-opus-4-7": defineModel({
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    family: "opus",
    reasoning: true,
    context: 1e6,
    output: 128e3,
    cost: opusCost,
    multiplier: 5,
    releaseDate: "2025-07-16"
  }),
  "claude-opus-4-8": defineModel({
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    family: "opus",
    reasoning: true,
    context: 1e6,
    output: 128e3,
    cost: opusCost,
    multiplier: 5,
    releaseDate: "2026-05-28"
  }),
  "claude-opus-5": defineModel({
    id: "claude-opus-5",
    name: "Claude Opus 5",
    family: "opus",
    reasoning: true,
    context: 1e6,
    output: 128e3,
    cost: opusCost,
    multiplier: 5,
    releaseDate: "2026-07-24"
  }),
  "claude-fable-5": defineModel({
    id: "claude-fable-5",
    name: "Claude Fable 5",
    family: "fable",
    reasoning: true,
    context: 1e6,
    output: 128e3,
    cost: fableCost,
    multiplier: 10,
    releaseDate: "2026-06-09"
  }),
  "claude-fable-5-1": defineModel({
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    family: "fable",
    reasoning: true,
    context: 1e6,
    output: 128e3,
    cost: fable51Cost,
    multiplier: 10,
    releaseDate: "2026-09-01"
  }),
  // Mythos 5 shares Fable 5's capabilities and pricing without the safety
  // classifiers; limited availability via Project Glasswing. `claude --model
  // claude-mythos-5` simply errors for accounts without access, so it's safe to
  // register unconditionally.
  "claude-mythos-5": defineModel({
    id: "claude-mythos-5",
    name: "Claude Mythos 5",
    family: "mythos",
    reasoning: true,
    context: 1e6,
    output: 128e3,
    cost: fableCost,
    multiplier: 10,
    releaseDate: "2026-06-09"
  })
};

// src/accounts.ts
import { chmod, lstat, mkdir, readlink, symlink, writeFile } from "fs/promises";
import path6 from "path";
var BASE_PROVIDER_ID = "claude-code";
var DEFAULT_ACCOUNT = "default";
var SHARED_CAPABILITY_ITEMS = [
  "CLAUDE.md",
  "settings.json",
  "skills",
  "agents",
  "commands",
  "plugins"
];
function normalizeAccountName(account) {
  return account.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function resolveAccounts(value) {
  if (!Array.isArray(value)) return null;
  const accounts = value.map((account) => normalizeAccountName(String(account))).filter(Boolean);
  return Array.from(/* @__PURE__ */ new Set([DEFAULT_ACCOUNT, ...accounts]));
}
function accountProviderId(account) {
  return `${BASE_PROVIDER_ID}-${normalizeAccountName(account)}`;
}
function accountDisplayName(account) {
  return `Claude Code (${titleizeAccount(account)})`;
}
function accountModelSuffix(account) {
  const normalized = normalizeAccountName(account);
  return normalized === DEFAULT_ACCOUNT ? void 0 : normalized;
}
function accountConfigDir(account) {
  const normalized = normalizeAccountName(account);
  if (!normalized || normalized === DEFAULT_ACCOUNT) return void 0;
  return `~/.claude-${normalized}`;
}
function expandHome(value) {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (value === "~") return home ?? value;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return home ? path6.join(home, value.slice(2)) : value;
  }
  return value;
}
async function ensureAccountRuntime(account, baseCliPath) {
  const configDir = accountConfigDir(account);
  if (!configDir) return { cliPath: baseCliPath };
  const expandedConfigDir = expandHome(configDir);
  await mkdir(expandedConfigDir, { recursive: true });
  try {
    await ensureSharedCapabilities(expandedConfigDir);
  } catch (err) {
    log.warn("failed to symlink shared capabilities; continuing anyway", {
      account,
      configDir: expandedConfigDir,
      error: String(err)
    });
  }
  const cliPath = await writeAccountWrapper(
    normalizeAccountName(account),
    baseCliPath,
    expandedConfigDir
  );
  return { cliPath, configDir: expandedConfigDir };
}
async function ensureSharedCapabilities(targetRoot) {
  const sourceRoot = expandHome("~/.claude");
  for (const item of SHARED_CAPABILITY_ITEMS) {
    await ensureSharedCapabilityItem(sourceRoot, targetRoot, item);
  }
}
async function ensureSharedCapabilityItem(sourceRoot, targetRoot, item) {
  const source = path6.join(sourceRoot, item);
  const target = path6.join(targetRoot, item);
  let sourceStat;
  try {
    sourceStat = await lstat(source);
  } catch {
    return;
  }
  try {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink()) {
      const current = await readlink(target);
      const resolvedCurrent = path6.resolve(path6.dirname(target), current);
      const resolvedSource = path6.resolve(source);
      if (resolvedCurrent === resolvedSource) return;
    }
    log.warn("shared Claude capability already exists; leaving untouched", {
      item,
      target,
      source
    });
    return;
  } catch {
  }
  const type = sourceStat.isDirectory() ? process.platform === "win32" ? "junction" : "dir" : "file";
  await symlink(source, target, type);
}
async function writeAccountWrapper(account, baseCliPath, configDir) {
  const cacheRoot = path6.join(
    process.env.XDG_CACHE_HOME ?? expandHome("~/.cache"),
    "opencode-claude-code-plugin"
  );
  const wrapperPath = path6.join(cacheRoot, `claude-${account}`);
  const suffix = `@${account}`;
  await mkdir(cacheRoot, { recursive: true });
  const script = `#!/usr/bin/env bash
set -euo pipefail

args=()
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--model" && $# -ge 2 ]]; then
    model="$2"
    if [[ "$model" == *${shellDoubleQuote(suffix)} ]]; then
      model="\${model%${shellDoubleQuote(suffix)}}"
    fi
    args+=("$1" "$model")
    shift 2
  else
    args+=("$1")
    shift
  fi
done

export CLAUDE_CONFIG_DIR=${shellSingleQuote(configDir)}
exec ${shellSingleQuote(baseCliPath)} "\${args[@]}"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 493);
  return wrapperPath;
}
function shellSingleQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function shellDoubleQuote(value) {
  return value.replace(/[$`"\\]/g, "\\$&");
}
function titleizeAccount(account) {
  return normalizeAccountName(account).split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

// src/cleanup-stale.ts
import {
  existsSync as existsSync4,
  readFileSync as readFileSync4,
  realpathSync,
  rmSync as rmSync3,
  writeFileSync as writeFileSync5
} from "fs";
import { homedir as homedir6 } from "os";
import { join as join8, resolve as resolve4 } from "path";
import { fileURLToPath } from "url";
var STALE_PACKAGE_NAME = "opencode-claude-code-plugin";
var SUSPECT_DESCRIPTION_TOKEN = "Claude Code";
var alreadyRan = false;
function candidateCacheRoots() {
  const xdg = process.env.XDG_CACHE_HOME;
  return [
    xdg ? join8(xdg, "opencode") : null,
    join8(homedir6(), ".cache", "opencode"),
    join8(homedir6(), "Library", "Caches", "opencode")
  ].filter((p) => Boolean(p));
}
function userOpencodeJsonPath() {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join8(homedir6(), ".config");
  return join8(xdgConfig, "opencode", "opencode.json");
}
function userIntendsToUseUnscoped() {
  const cfg = userOpencodeJsonPath();
  if (!existsSync4(cfg)) return false;
  try {
    const json = JSON.parse(readFileSync4(cfg, "utf8"));
    const plugins = json.plugin;
    if (!Array.isArray(plugins)) return false;
    return plugins.some(
      (entry) => typeof entry === "string" && /^opencode-claude-code-plugin(@[^/]+)?$/.test(entry)
    );
  } catch {
    return false;
  }
}
function ourLoadedDir() {
  try {
    const filePath = fileURLToPath(import.meta.url);
    return realpathSync(resolve4(filePath, "..", ".."));
  } catch {
    return null;
  }
}
function cleanupStaleUnscopedInstall() {
  if (alreadyRan) return;
  alreadyRan = true;
  if (process.env.OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP === "1") return;
  if (userIntendsToUseUnscoped()) return;
  const ourDir = ourLoadedDir();
  for (const cacheRoot of candidateCacheRoots()) {
    try {
      cleanupOne(cacheRoot, ourDir);
    } catch (err) {
      log.warn("cleanup-stale: error processing cache root", {
        cacheRoot,
        error: String(err)
      });
    }
  }
}
function cleanupOne(cacheRoot, ourDir) {
  if (!existsSync4(cacheRoot)) return;
  const stalePath = join8(cacheRoot, "node_modules", STALE_PACKAGE_NAME);
  if (!existsSync4(stalePath)) return;
  let realStalePath = stalePath;
  try {
    realStalePath = realpathSync(stalePath);
  } catch {
  }
  if (ourDir && realStalePath === ourDir) return;
  const pkgJsonPath = join8(stalePath, "package.json");
  if (!existsSync4(pkgJsonPath)) return;
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync4(pkgJsonPath, "utf8"));
  } catch {
    return;
  }
  if (pkg.name !== STALE_PACKAGE_NAME) return;
  if (!pkg.description?.includes(SUSPECT_DESCRIPTION_TOKEN)) return;
  log.info("cleanup-stale: removing unscoped install", { stalePath });
  try {
    rmSync3(stalePath, { recursive: true, force: true });
  } catch (err) {
    log.warn("cleanup-stale: rmSync failed", {
      stalePath,
      error: String(err)
    });
    return;
  }
  const cachePkgJson = join8(cacheRoot, "package.json");
  if (!existsSync4(cachePkgJson)) return;
  try {
    const cfg = JSON.parse(readFileSync4(cachePkgJson, "utf8"));
    if (cfg?.dependencies?.[STALE_PACKAGE_NAME]) {
      delete cfg.dependencies[STALE_PACKAGE_NAME];
      writeFileSync5(cachePkgJson, JSON.stringify(cfg, null, 2) + "\n");
      log.info("cleanup-stale: pruned dep from cache package.json");
    }
  } catch (err) {
    log.warn("cleanup-stale: cache package.json update failed", {
      error: String(err)
    });
  }
}

// src/startup-diagnostics.ts
import { execFile as execFile2 } from "child_process";
import * as fs6 from "fs";
import * as path7 from "path";
import { promisify as promisify2 } from "util";
import { fileURLToPath as fileURLToPath2 } from "url";
var cachedPluginVersion;
function pluginVersion() {
  if (cachedPluginVersion) return cachedPluginVersion;
  try {
    const here = path7.dirname(fileURLToPath2(import.meta.url));
    const raw = fs6.readFileSync(path7.join(here, "..", "package.json"), "utf8");
    const version = JSON.parse(raw).version;
    cachedPluginVersion = typeof version === "string" ? version : "unknown";
  } catch {
    cachedPluginVersion = "unknown";
  }
  return cachedPluginVersion;
}
function pickOpencodeVersion(input) {
  if (!input || typeof input !== "object") return void 0;
  const app = input.app;
  if (app && typeof app === "object") {
    const version = app.version;
    if (typeof version === "string" && version.length > 0) return version;
  }
  const direct = input.version;
  if (typeof direct === "string" && direct.length > 0) return direct;
  return void 0;
}
var execFileAsync2 = promisify2(execFile2);
var opencodeVersionProbe;
function detectOpencodeVersion(execPath = process.execPath) {
  if (opencodeVersionProbe) return opencodeVersionProbe;
  opencodeVersionProbe = (async () => {
    if (!path7.basename(execPath).toLowerCase().includes("opencode")) {
      log.debug("skipping opencode version probe: execPath is not opencode", { execPath });
      return void 0;
    }
    try {
      const { stdout } = await execFileAsync2(execPath, ["--version"], { timeout: 5e3 });
      const match = /\d+\.\d+\.\d+\S*/.exec(stdout.trim());
      return match ? match[0] : void 0;
    } catch (err) {
      log.debug("opencode version probe failed", {
        execPath,
        error: err instanceof Error ? err.message : String(err)
      });
      return void 0;
    }
  })();
  return opencodeVersionProbe;
}
function describeSpawnCwd(configured, live = process.cwd(), captured = getOpencodeProjectDirectory()) {
  if (typeof configured === "string" && configured.length > 0) {
    return { resolved: configured, source: "configured" };
  }
  if (isUsableDirectory(live)) return { resolved: live, source: "process" };
  if (isUsableDirectory(captured)) return { resolved: captured, source: "captured" };
  return { resolved: live, source: "unresolved" };
}
function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string");
}
function firstOption(providers, key) {
  for (const entry of Object.values(providers)) {
    const value = entry?.options?.[key];
    if (value !== void 0) return value;
  }
  return void 0;
}
function collectStartupDiagnostics(providers, opencodeVersion) {
  const accounts = [];
  for (const entry of Object.values(providers)) {
    const account = entry?.options?.account;
    if (typeof account === "string" && account.length > 0) accounts.push(account);
  }
  const cwd = describeSpawnCwd(firstOption(providers, "cwd"));
  let mcpServers = [];
  try {
    mcpServers = mergeOpencodeMcp(cwd.resolved).enabledServerNames;
  } catch (err) {
    log.debug("startup diagnostics could not read MCP config", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return {
    plugin: pluginVersion(),
    opencode: opencodeVersion ?? process.env.OPENCODE_VERSION ?? "unknown",
    claudeCliPath: String(firstOption(providers, "cliPath") ?? "claude"),
    cwd,
    providers: Object.keys(providers),
    accounts,
    proxyTools: stringList(firstOption(providers, "proxyTools")),
    mcpServers,
    interactiveTransport: firstOption(providers, "interactive") === true || process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT === "1",
    anthropicApiKeyInEnv: Boolean(
      process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
    )
  };
}
var logged = false;
function logStartupDiagnostics(providers, opencodeVersion) {
  if (logged) return;
  logged = true;
  void (async () => {
    try {
      const version = opencodeVersion ?? process.env.OPENCODE_VERSION ?? await detectOpencodeVersion();
      const { claudeCliPath, ...rest } = collectStartupDiagnostics(providers, version);
      const cli = await detectCliVersion(claudeCliPath);
      const diagnostics = {
        ...rest,
        claudeCli: { path: claudeCliPath, version: cli?.raw ?? "not detected" }
      };
      log.notice("claude-code plugin ready", { ...diagnostics });
    } catch (err) {
      log.debug("startup diagnostics failed", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  })();
}

// src/index.ts
function pickOpencodeDirectory(input) {
  if (!input || typeof input !== "object") return void 0;
  const ctx = input;
  if (isUsableDirectory(ctx.directory)) return ctx.directory;
  if (isUsableDirectory(ctx.worktree)) return ctx.worktree;
  return void 0;
}
var warnedAnthropicApiKey = false;
var DEFAULT_PROXY_TOOL_NAMES = [
  "Bash",
  "Edit",
  "Write",
  "WebFetch",
  "Task"
];
function warnIfAnthropicApiKey(ignore) {
  if (warnedAnthropicApiKey) return;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return;
  warnedAnthropicApiKey = true;
  if (ignore) {
    log.warn(
      "ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN detected; stripping it from claude spawns (ignoreAnthropicApiKey) so requests use your subscription auth, not pay-as-you-go API billing."
    );
  } else {
    log.warn(
      "ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN detected; claude may bill as pay-as-you-go API usage instead of your subscription / Agent SDK credit. Set provider option `ignoreAnthropicApiKey: true` to force subscription auth."
    );
  }
}
function createClaudeCode(settings = {}) {
  if (settings.logging) {
    configureLogger({
      file: settings.logging.file ?? false,
      dir: settings.logging.dir ?? null,
      mode: settings.logging.mode ?? "silent",
      level: settings.logging.level ?? "info"
    });
  }
  warnIfAnthropicApiKey(settings.ignoreAnthropicApiKey);
  const cliPath = settings.cliPath ?? process.env.CLAUDE_CLI_PATH ?? "claude";
  const providerName = settings.providerID ?? settings.name ?? "claude-code";
  const proxyTools = settings.proxyTools ?? [...DEFAULT_PROXY_TOOL_NAMES];
  const createModel = (modelId) => {
    return new ClaudeCodeLanguageModel(modelId, {
      provider: providerName,
      cliPath,
      cwd: settings.cwd,
      account: settings.account,
      configDir: settings.configDir,
      providerID: settings.providerID,
      skipPermissions: settings.skipPermissions ?? true,
      permissionMode: settings.permissionMode,
      mcpConfig: settings.mcpConfig,
      strictMcpConfig: settings.strictMcpConfig,
      bridgeOpencodeMcp: settings.bridgeOpencodeMcp ?? true,
      bridgeOpencodeSkills: settings.bridgeOpencodeSkills ?? true,
      controlRequestBehavior: settings.controlRequestBehavior ?? "allow",
      controlRequestToolBehaviors: settings.controlRequestToolBehaviors,
      controlRequestDenyMessage: settings.controlRequestDenyMessage,
      proxyTools,
      proxyToolTimeoutMs: settings.proxyToolTimeoutMs,
      webSearch: settings.webSearch,
      hotReloadMcp: settings.hotReloadMcp ?? true,
      proxyOpencodeMcpTools: settings.proxyOpencodeMcpTools ?? true,
      multiStepContinuation: settings.multiStepContinuation ?? true,
      autoContinueIncompleteTurns: settings.autoContinueIncompleteTurns ?? "smart",
      compactionModel: settings.compactionModel,
      ignoreAnthropicApiKey: settings.ignoreAnthropicApiKey,
      interactive: settings.interactive,
      interactiveBypass: settings.interactiveBypass,
      interactiveAllowTools: settings.interactiveAllowTools,
      interactiveSystemPrompt: settings.interactiveSystemPrompt
    });
  };
  const provider = function(modelId) {
    return createModel(modelId);
  };
  provider.specificationVersion = "v3";
  provider.languageModel = createModel;
  return provider;
}
var PROVIDER_ID2 = BASE_PROVIDER_ID;
var PACKAGE_NPM = "@khalilgharbaoui/opencode-claude-code-plugin";
function pluginEntrypoint() {
  return import.meta.url.startsWith("file:") ? import.meta.url : PACKAGE_NPM;
}
function cleanProviderOptions(options = {}) {
  const result = { ...options };
  delete result.accounts;
  return result;
}
function defaultModelsForProvider(providerModels, providerID = PROVIDER_ID2, modelSuffix) {
  const models = Object.fromEntries(
    Object.entries(defaultModels).map(([id, model]) => {
      const modelId = modelSuffix ? `${id}@${modelSuffix}` : id;
      const existing = providerModels[id] ?? providerModels[modelId];
      return [
        modelId,
        {
          ...model,
          id: modelId,
          providerID,
          api: {
            ...model.api,
            id: modelId,
            npm: existing?.api?.npm ?? model.api.npm,
            url: existing?.api?.url ?? model.api.url
          }
        }
      ];
    })
  );
  for (const [id, model] of Object.entries(providerModels)) {
    if (!(id in models)) {
      models[id] = {
        ...model,
        providerID
      };
    }
  }
  return models;
}
function configModelsForProvider(providerModels, providerID, modelSuffix) {
  const models = {};
  for (const [id, model] of Object.entries(defaultModels)) {
    const modelId = modelSuffix ? `${id}@${modelSuffix}` : id;
    const existing = providerModels[id] ?? providerModels[modelId];
    const existingVariants = existing && typeof existing.variants === "object" ? existing.variants ?? {} : {};
    const full = {
      ...model,
      id: modelId,
      providerID,
      api: {
        ...model.api,
        id: modelId,
        npm: existing?.api?.npm ?? model.api.npm,
        url: existing?.api?.url ?? model.api.url
      },
      variants: {
        ...model.variants ?? {},
        ...existingVariants
      }
    };
    models[modelId] = toConfigModel(full);
  }
  for (const [id, model] of Object.entries(providerModels)) {
    if (!(id in models)) {
      models[id] = toConfigModel({ ...model, providerID });
    }
  }
  return models;
}
async function providerConfig(existing, providerID = PROVIDER_ID2, optionDefaults = {}, displayName) {
  const mergedOptions = {
    cliPath: "claude",
    proxyTools: [...DEFAULT_PROXY_TOOL_NAMES],
    ...optionDefaults,
    ...cleanProviderOptions(existing?.options),
    providerID
  };
  const cliPath = String(mergedOptions.cliPath ?? "claude");
  const account = typeof mergedOptions.account === "string" ? mergedOptions.account : void 0;
  const runtime = account ? await ensureAccountRuntime(account, cliPath) : { cliPath };
  return {
    name: displayName ?? existing?.name,
    npm: existing?.npm ?? pluginEntrypoint(),
    options: {
      ...mergedOptions,
      ...runtime
    }
    // models is intentionally omitted: both callers overwrite it with
    // configModelsForProvider(), which emits the flat config schema
    // opencode's config-path loader parses (and merges user variants).
  };
}
function claudeCodeProviders(providers) {
  const out = {};
  for (const [id, entry] of Object.entries(providers ?? {})) {
    if (id === PROVIDER_ID2 || id.startsWith(`${PROVIDER_ID2}-`)) out[id] = entry;
  }
  return out;
}
async function expandAccountProviders(config) {
  const seed = config.provider?.[PROVIDER_ID2];
  const accounts = resolveAccounts(seed?.options?.accounts);
  if (!accounts) return false;
  config.provider ??= {};
  const seedOptions = cleanProviderOptions(seed?.options);
  let expandedCount = 0;
  for (const account of accounts) {
    const providerID = accountProviderId(account);
    try {
      const existing = config.provider[providerID];
      const modelSuffix = accountModelSuffix(account);
      config.provider[providerID] = {
        ...existing,
        ...await providerConfig(
          existing,
          providerID,
          {
            ...seedOptions,
            account
          },
          accountDisplayName(account)
        ),
        models: configModelsForProvider(
          existing?.models ?? seed?.models ?? {},
          providerID,
          modelSuffix
        )
      };
      expandedCount++;
    } catch (err) {
      log.error("failed to expand account provider", {
        account,
        providerID,
        error: String(err)
      });
    }
  }
  if (expandedCount > 0) {
    delete config.provider[PROVIDER_ID2];
  }
  return expandedCount > 0;
}
var processLifecycleWired = false;
function wireProcessLifecycle() {
  if (processLifecycleWired) return;
  processLifecycleWired = true;
  startIdleProcessReaper();
  process.on("exit", killAllActiveProcesses);
}
var server = async (input) => {
  cleanupStaleUnscopedInstall();
  wireProcessLifecycle();
  const opencodeVersion = pickOpencodeVersion(input);
  if (input && typeof input === "object" && "client" in input) {
    setOpencodeClient(input.client);
  }
  setOpencodeProjectDirectory(pickOpencodeDirectory(input));
  return {
    config: async (config) => {
      config.provider ??= {};
      const expanded = await expandAccountProviders(config);
      if (expanded) {
        logStartupDiagnostics(
          claudeCodeProviders(config.provider),
          opencodeVersion
        );
        return;
      }
      const existing = config.provider[PROVIDER_ID2];
      config.provider[PROVIDER_ID2] = {
        ...existing,
        ...await providerConfig(existing),
        models: configModelsForProvider(
          existing?.models ?? {},
          PROVIDER_ID2
        )
      };
      logStartupDiagnostics(
        claudeCodeProviders(config.provider),
        opencodeVersion
      );
    },
    // Only `session.deleted` is acted on. MCP config drift is still detected
    // at turn start by the hot-reload check in `claude-code-language-model.ts`,
    // which respawns claude safely between turns, and eviction on
    // `global.disposed` would kill an in-flight stream and abort the user's
    // current turn. A deleted session has no turn left to abort, and its CLI
    // process would otherwise linger until LRU pressure evicted it.
    event: async ({ event }) => {
      const payload = event?.payload ?? event;
      if (payload?.type !== "session.deleted") return;
      const properties = payload.properties;
      const sessionID = properties?.info?.id ?? properties?.sessionID;
      if (typeof sessionID !== "string" || !sessionID) return;
      const released = deleteActiveProcessesForAffinity(sessionID);
      if (released.length > 0) {
        log.info("released claude processes for deleted session", {
          sessionID,
          released
        });
      }
    },
    provider: {
      id: PROVIDER_ID2,
      models: async (provider) => defaultModelsForProvider(provider.models)
    },
    // Inject opencode's agent name into providerOptions so the language
    // model can distinguish /compact (and title) calls from normal turns.
    // Without this, every no-tools call looks like a title request and
    // gets short-circuited to a synthetic stub.
    "chat.params": async (input2, output) => {
      const providerID = input2.model?.providerID ?? input2.provider?.info?.id;
      log.debug("chat.params hook fired", {
        agent: input2.agent,
        providerID,
        sessionID: input2.sessionID
      });
      if (typeof providerID !== "string") return;
      if (providerID !== PROVIDER_ID2 && !providerID.startsWith(`${PROVIDER_ID2}-`)) return;
      if (typeof input2.sessionID === "string" && input2.sessionID.length > 0) {
        output.options ??= {};
        output.options.opencodeSessionID = input2.sessionID;
      }
      if (!input2.agent) return;
      output.options ??= {};
      output.options.opencodeAgent = input2.agent;
      log.debug("chat.params tagged providerOptions", {
        agent: input2.agent,
        sessionID: input2.sessionID,
        providerID
      });
    }
  };
};
var index_default = {
  id: "@khalilgharbaoui/opencode-claude-code-plugin",
  server
};
export {
  ClaudeCodeLanguageModel,
  bridgeOpencodeMcp,
  claudeCodeProviders,
  configModelsForProvider,
  createClaudeCode,
  index_default as default,
  defaultModels
};
//# sourceMappingURL=index.js.map