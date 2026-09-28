// src/claude-code-language-model.ts
import { generateId as generateId3 } from "@ai-sdk/provider-utils";

// src/host-tools.ts
function defined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== void 0));
}
var V2_TOOLS = {
  bash: {
    name: "shell",
    // V2's shell takes no `description`; `workdir`, `timeout` and
    // `background` keep their names.
    input: (input) => defined({
      command: input.command,
      workdir: input.workdir,
      timeout: input.timeout,
      background: input.background
    })
  },
  edit: {
    name: "edit",
    input: (input) => defined({
      path: input.filePath ?? input.path,
      oldString: input.oldString,
      newString: input.newString,
      replaceAll: input.replaceAll
    })
  },
  write: {
    name: "write",
    input: (input) => defined({ path: input.filePath ?? input.path, content: input.content })
  },
  read: {
    name: "read",
    input: (input) => defined({ path: input.filePath ?? input.path, offset: input.offset, limit: input.limit })
  },
  glob: { name: "glob" },
  grep: { name: "grep" },
  webfetch: { name: "webfetch" },
  websearch: { name: "websearch" },
  question: { name: "question" },
  task: {
    name: "subagent",
    input: (input) => defined({
      agent: input.subagent_type ?? input.agent,
      description: input.description,
      prompt: input.prompt,
      sessionID: input.task_id ?? input.sessionID,
      background: input.background
    })
  },
  todowrite: null,
  plan_enter: null,
  plan_exit: null,
  notebookedit: null
};
function parseInput(raw) {
  if (typeof raw !== "string") return raw ?? {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function createHostToolPartTranslator(dialect = "v1") {
  if (dialect !== "v2") return (part) => part;
  const dropped = /* @__PURE__ */ new Set();
  const translated = /* @__PURE__ */ new Map();
  const classify2 = (id, name) => {
    if (dropped.has(id)) return null;
    const known = translated.get(id);
    if (known) return known;
    if (typeof name !== "string") return void 0;
    const tool = V2_TOOLS[name];
    if (tool === null) {
      dropped.add(id);
      return null;
    }
    if (tool) translated.set(id, tool);
    return tool;
  };
  return (part) => {
    switch (part.type) {
      case "tool-input-start": {
        const tool = classify2(String(part.id), part.toolName);
        if (tool === null) return null;
        return tool ? { ...part, toolName: tool.name } : part;
      }
      case "tool-input-delta": {
        const tool = classify2(String(part.id), void 0);
        if (tool === null) return null;
        return tool?.input ? null : part;
      }
      case "tool-input-end": {
        return classify2(String(part.id), void 0) === null ? null : part;
      }
      case "tool-call": {
        const tool = classify2(String(part.toolCallId), part.toolName);
        if (tool === null) return null;
        if (!tool) return part;
        const input = tool.input ? tool.input(parseInput(part.input)) : parseInput(part.input);
        return {
          ...part,
          toolName: tool.name,
          input: typeof part.input === "string" ? JSON.stringify(input) : input
        };
      }
      case "tool-result": {
        const tool = classify2(String(part.toolCallId), part.toolName);
        if (tool === null) return null;
        return tool ? { ...part, toolName: tool.name } : part;
      }
      default:
        return part;
    }
  };
}
function translateStreamForHost(stream, dialect = "v1") {
  if (dialect !== "v2") return stream;
  const translate = createHostToolPartTranslator(dialect);
  return stream.pipeThrough(
    new TransformStream({
      transform(part, controller) {
        const next = translate(part);
        if (next) controller.enqueue(next);
      }
    })
  );
}

// src/account-failover.ts
import { homedir as homedir2 } from "os";

// src/accounts.ts
import { chmod, lstat, mkdir, readlink, symlink, writeFile } from "fs/promises";
import path from "path";

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

// src/accounts.ts
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
function accountConfigDirPath(account) {
  const dir = accountConfigDir(account);
  return dir ? expandHome(dir) : void 0;
}
function expandHome(value) {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (value === "~") return home ?? value;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return home ? path.join(home, value.slice(2)) : value;
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
  const source = path.join(sourceRoot, item);
  const target = path.join(targetRoot, item);
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
      const resolvedCurrent = path.resolve(path.dirname(target), current);
      const resolvedSource = path.resolve(source);
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
  const cacheRoot = path.join(
    process.env.XDG_CACHE_HOME ?? expandHome("~/.cache"),
    "opencode-claude-code-plugin"
  );
  const wrapperPath = path.join(cacheRoot, `claude-${account}`);
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
# \${args[@]+...} keeps an empty array legal under \`set -u\` on bash 3.2,
# which is the bash macOS ships and \`/usr/bin/env bash\` usually finds.
exec ${shellSingleQuote(baseCliPath)} \${args[@]+"\${args[@]}"}
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

// src/types.ts
var READ_ONLY_PERMISSION_MODE = "read-only";
var DEFAULT_PROXY_TOOL_NAMES = [
  "Bash",
  "Edit",
  "Write",
  "WebFetch",
  "Task"
];
var PROXY_MCP_SERVER_NAME = "opencode_proxy";

// src/cli-events.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function str(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
var RATE_LIMIT_MARKER = "\u258C **rate limit:**";
var RATE_LIMIT_ACTION = "Enable extra usage or add credits on the account, wait for the window to reset, switch account, org or plan, or authenticate with an API key.";
var OVERAGE_DISABLED_REASONS = {
  overage_not_provisioned: "extra usage is not set up on this account",
  org_level_disabled: "extra usage is disabled for your organization",
  org_level_disabled_until: "extra usage is disabled for your organization for now",
  out_of_credits: "the account's usage credits are spent",
  seat_tier_level_disabled: "your seat tier does not allow extra usage",
  member_level_disabled: "extra usage is disabled for your member account",
  seat_tier_zero_credit_limit: "your seat tier has a zero credit limit",
  group_zero_credit_limit: "your group has a zero credit limit",
  member_zero_credit_limit: "your member account has a zero credit limit",
  org_service_level_disabled: "your organization's service level does not include extra usage",
  no_limits_configured: "no usage limits are configured for this account",
  fetch_error: "the CLI could not read the account's usage limits"
};
var RATE_LIMIT_WINDOWS = {
  five_hour: "the 5-hour window",
  seven_day: "the 7-day window",
  seven_day_opus: "the 7-day Opus window",
  seven_day_sonnet: "the 7-day Sonnet window",
  seven_day_overage_included: "the 7-day extra-usage window",
  overage: "extra usage"
};
function parseRateLimitEvent(msg) {
  if (msg.type !== "rate_limit_event") return null;
  const info = msg.rate_limit_info;
  if (!isRecord(info)) return null;
  return {
    status: str(info.status),
    rateLimitType: str(info.rateLimitType),
    resetsAt: num(info.resetsAt),
    utilization: num(info.utilization),
    isUsingOverage: info.isUsingOverage === true,
    overageStatus: str(info.overageStatus),
    overageResetsAt: num(info.overageResetsAt),
    overageDisabledReason: str(info.overageDisabledReason)
  };
}
function resetsAtToMs(resetsAt) {
  if (resetsAt === void 0 || !Number.isFinite(resetsAt)) return void 0;
  return resetsAt < 1e12 ? resetsAt * 1e3 : resetsAt;
}
function formatResetsAt(resetsAt) {
  const ms = resetsAtToMs(resetsAt);
  if (ms === void 0) return void 0;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? void 0 : date.toISOString();
}
function rateLimitKey(info) {
  return [
    info.status ?? "?",
    info.rateLimitType ?? "?",
    info.overageStatus ?? "?",
    info.overageDisabledReason ?? "?"
  ].join("|");
}
function isRateLimitRejected(info) {
  if (info.status === "rejected") return true;
  if (info.status === "allowed" || info.status === "allowed_warning") return false;
  return info.overageStatus === "rejected";
}
function describeRateLimit(info) {
  if (!info.status && !info.overageStatus) return null;
  const window = info.rateLimitType ? RATE_LIMIT_WINDOWS[info.rateLimitType] ?? info.rateLimitType : void 0;
  const resets = formatResetsAt(info.resetsAt);
  const overageResets = formatResetsAt(info.overageResetsAt);
  const key = rateLimitKey(info);
  if (isRateLimitRejected(info)) {
    const parts = [];
    parts.push(
      info.status === "rejected" ? `Claude Code rejected this request: you are out of usage${window ? ` in ${window}` : ""}.` : "Claude Code rejected this request: paid extra usage is not available on this account."
    );
    const reason = info.overageDisabledReason ? OVERAGE_DISABLED_REASONS[info.overageDisabledReason] ?? info.overageDisabledReason : void 0;
    if (reason) parts.push(`Extra usage is unavailable because ${reason}.`);
    const resetAt = resets ?? overageResets;
    if (resetAt) parts.push(`Resets at ${resetAt}.`);
    parts.push(RATE_LIMIT_ACTION);
    const message = parts.join(" ");
    return { key, level: "warn", message, transcript: `
${RATE_LIMIT_MARKER} ${message}
` };
  }
  if (info.status === "allowed_warning" || info.overageStatus === "allowed_warning") {
    const used = info.utilization === void 0 ? "" : ` (${Math.round(info.utilization * 100)}% used)`;
    return {
      key,
      level: "notice",
      message: `Approaching the usage limit${window ? ` for ${window}` : ""}${used}${resets ? `, resets at ${resets}` : ""}.`,
      transcript: null
    };
  }
  return {
    key,
    level: "info",
    message: `usage limits updated${window ? ` for ${window}` : ""}`,
    transcript: null
  };
}
var reportedRateLimits = /* @__PURE__ */ new Set();
function reportRateLimitEvent(msg) {
  const info = parseRateLimitEvent(msg);
  if (!info) return null;
  const report = describeRateLimit(info);
  if (!report) return null;
  const data = { ...info };
  if (reportedRateLimits.has(report.key)) {
    log.debug(report.message, data);
    return null;
  }
  reportedRateLimits.add(report.key);
  log[report.level](report.message, data);
  return report.transcript;
}
var MCP_SERVER_ERROR_TYPES = {
  unknown_type: "its `type` is not one Claude Code knows",
  url_missing_type: "it has a `url` but no `type`",
  invalid_config: "its configuration did not validate",
  reserved_name: "its name is reserved"
};
function parseMcpServerErrors(msg) {
  const raw = msg.mcp_server_errors;
  if (!Array.isArray(raw)) return [];
  const errors = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    errors.push({
      name: str(entry.name) ?? "unknown",
      type: str(entry.type) ?? "unknown",
      message: str(entry.message) ?? ""
    });
  }
  return errors;
}
function describeMcpServerError(error) {
  const why = MCP_SERVER_ERROR_TYPES[error.type];
  const reason = why ? ` because ${why}` : "";
  const detail = error.message ? ` Claude Code said: ${error.message}` : "";
  if (error.name === PROXY_MCP_SERVER_NAME) {
    return `Claude Code skipped the plugin's own MCP server "${error.name}" (${error.type})${reason}, so every proxied tool call this session will fail. This is a plugin bug or a corrupted scratch config rather than something in your own MCP settings: report it with this line.${detail}`;
  }
  return `Claude Code skipped MCP server "${error.name}" (${error.type})${reason}, so its tools are not available to the model this session. Fix the entry in your MCP config.${detail}`;
}
var API_KEY_SOURCES = /* @__PURE__ */ new Set([
  "ANTHROPIC_API_KEY",
  "apiKeyHelper",
  "/login managed key",
  "user",
  "project",
  "org",
  "temporary"
]);
function parseSystemInit(msg) {
  if (msg.type !== "system" || msg.subtype !== "init") return null;
  const raw = msg;
  const servers = [];
  if (Array.isArray(raw.mcp_servers)) {
    for (const entry of raw.mcp_servers) {
      if (!isRecord(entry)) continue;
      servers.push({ name: str(entry.name) ?? "unknown", status: str(entry.status) ?? "unknown" });
    }
  }
  return {
    apiKeySource: str(raw.apiKeySource),
    permissionMode: str(raw.permissionMode),
    model: str(raw.model),
    cliVersion: str(raw.claude_code_version),
    toolCount: Array.isArray(raw.tools) ? raw.tools.length : 0,
    mcpServers: servers,
    mcpServerErrors: parseMcpServerErrors(msg)
  };
}
function apiKeySourceWarning(apiKeySource, ignoreAnthropicApiKey) {
  if (!apiKeySource || !API_KEY_SOURCES.has(apiKeySource)) return null;
  const base = `Claude Code authenticated with an API key (apiKeySource: ${apiKeySource}), so these turns bill as pay-as-you-go API usage instead of your subscription.`;
  return ignoreAnthropicApiKey ? `${base} \`ignoreAnthropicApiKey\` is already on, so the key is not coming from the environment: check the CLI's own settings (\`claude config\`) or an \`apiKeyHelper\`.` : `${base} Set the provider option \`ignoreAnthropicApiKey: true\` to strip the key from spawns and fall back to the stored subscription auth.`;
}
var warnedApiKeySources = /* @__PURE__ */ new Set();
var warnedMcpFailures = /* @__PURE__ */ new Set();
var warnedMcpSkips = /* @__PURE__ */ new Set();
var lastMcpServerErrors = /* @__PURE__ */ new Map();
function snapshotMcpServerErrors() {
  return [...lastMcpServerErrors.values()];
}
function reportSystemInit(msg, options = {}) {
  const info = parseSystemInit(msg);
  if (!info) return;
  log.info("claude session init", {
    apiKeySource: info.apiKeySource ?? null,
    permissionMode: info.permissionMode ?? null,
    model: info.model ?? null,
    cliVersion: info.cliVersion ?? null,
    tools: info.toolCount,
    mcpServers: info.mcpServers,
    mcpServerErrors: info.mcpServerErrors
  });
  for (const error of info.mcpServerErrors) {
    lastMcpServerErrors.set(error.name, error);
    const key2 = `${error.name}:${error.type}`;
    const message = describeMcpServerError(error);
    if (warnedMcpSkips.has(key2)) {
      log.debug(message, { server: error.name, type: error.type });
      continue;
    }
    warnedMcpSkips.add(key2);
    log.warn(message, { server: error.name, type: error.type });
  }
  for (const server2 of info.mcpServers) {
    if (server2.status === "connected") continue;
    const key2 = `${server2.name}:${server2.status}`;
    const message = `MCP server "${server2.name}" is ${server2.status} in Claude Code; its tools are not available to the model this session.`;
    if (warnedMcpFailures.has(key2)) {
      log.debug(message, { server: server2.name, status: server2.status });
      continue;
    }
    warnedMcpFailures.add(key2);
    log.warn(message, { server: server2.name, status: server2.status });
  }
  const apiKeyMessage = apiKeySourceWarning(info.apiKeySource, options.ignoreAnthropicApiKey);
  if (!apiKeyMessage) return;
  const key = `${info.apiKeySource}:${options.ignoreAnthropicApiKey ? "ignored" : "passed"}`;
  if (warnedApiKeySources.has(key)) {
    log.debug(apiKeyMessage, { apiKeySource: info.apiKeySource });
    return;
  }
  warnedApiKeySources.add(key);
  log.warn(apiKeyMessage, { apiKeySource: info.apiKeySource });
}
var COMPACT_BOUNDARY_MARKER = "\u258C **context compacted:**";
function parseCompactBoundary(msg) {
  if (msg.type !== "system" || msg.subtype !== "compact_boundary") return null;
  const raw = msg;
  const meta = isRecord(raw.compact_metadata) ? raw.compact_metadata : isRecord(raw.compactMetadata) ? raw.compactMetadata : void 0;
  return {
    trigger: str(meta?.trigger) ?? "unknown",
    preTokens: num(meta?.pre_tokens) ?? num(meta?.preTokens),
    postTokens: num(meta?.post_tokens) ?? num(meta?.postTokens)
  };
}
function formatCompactBoundaryNote(boundary) {
  const how = boundary.trigger === "auto" ? "on its own" : `on a ${boundary.trigger} request`;
  const sizes = boundary.preTokens !== void 0 && boundary.postTokens !== void 0 ? ` (${boundary.preTokens.toLocaleString("en-US")} tokens to ${boundary.postTokens.toLocaleString("en-US")})` : "";
  return `
${COMPACT_BOUNDARY_MARKER} Claude Code compacted its own context ${how}${sizes}. Earlier detail in this conversation is now a summary.
`;
}
function reportCompactBoundary(msg) {
  const boundary = parseCompactBoundary(msg);
  if (!boundary) return null;
  log.notice("claude code compacted its own context", {
    trigger: boundary.trigger,
    preTokens: boundary.preTokens ?? null,
    postTokens: boundary.postTokens ?? null
  });
  return formatCompactBoundaryNote(boundary);
}
var CONVERSATION_RESET_MARKER = "\u258C **claude code reset:**";
function parseConversationReset(msg) {
  if (msg.type !== "conversation_reset") return null;
  const newConversationId = str(msg.new_conversation_id);
  if (!newConversationId) return null;
  return { newConversationId, previousSessionId: str(msg.session_id) };
}
function formatConversationResetNote() {
  return `
${CONVERSATION_RESET_MARKER} Claude Code cleared its conversation, so from here on Claude does not see the earlier messages this chat still shows. Start a new opencode session for a clean slate, or restate what matters.
`;
}
function reportConversationReset(msg) {
  const reset = parseConversationReset(msg);
  if (!reset) return null;
  log.notice("claude code reset its conversation", {
    newConversationId: reset.newConversationId,
    previousSessionId: reset.previousSessionId ?? null
  });
  return formatConversationResetNote();
}
var RESULT_ERROR_MARKER = "\u258C **claude code error:**";
var RESULT_SUBTYPES = {
  error_max_turns: "it hit its internal turn limit before finishing",
  error_during_execution: "it failed while running the turn",
  error_max_budget_usd: "it hit the configured spend limit for the turn",
  error_max_structured_output_retries: "it could not produce valid structured output"
};
function describeResultFailure(msg) {
  if (msg.type !== "result") return null;
  const subtype = msg.subtype;
  if (!subtype || subtype === "success") return null;
  const explanation = RESULT_SUBTYPES[subtype];
  return explanation ? `Claude Code ended the turn with \`${subtype}\`: ${explanation}.` : `Claude Code ended the turn with \`${subtype}\`.`;
}
function formatResultFailureNote(message) {
  return `
${RESULT_ERROR_MARKER} ${message}
`;
}
var STREAM_TIMEOUT_MARKER = "\u258C **stream timeout:**";
function formatStreamTimeoutNote(silenceMs) {
  const seconds = Math.max(1, Math.round(silenceMs / 1e3));
  return `
${STREAM_TIMEOUT_MARKER} The Claude Code CLI produced output and then went silent for ${seconds}s without finishing the turn, so it was closed without a result. The answer above may be incomplete.
`;
}
var SILENT_TURN_MARKER = "\u258C **no reply:**";
function formatSilentTurnNote(hadReasoning) {
  const what = hadReasoning ? "Claude Code finished the turn after thinking but never wrote an answer" : "Claude Code finished the turn without writing anything or calling a tool";
  return `
${SILENT_TURN_MARKER} ${what}, so there is no reply above. Nothing failed and nothing is pending: send the message again, or rephrase it.
`;
}

// src/plan-mode-question.ts
var QUESTION_TOOL_NAME = "question";
var APPROVED_EXIT_PLAN_MODE_MESSAGE = "User has approved your plan. You can now start coding. Start with updating your todo list if applicable.";
var REJECTED_EXIT_PLAN_MODE_PREFIX = "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said:";
var PLAN_MODE_APPROVAL_QUESTION = "Do you want to proceed with this plan?";
var OPENCODE_QUESTION_RESULT_PREFIX = "User has answered your questions: ";
var OPENCODE_QUESTION_RESULT_SUFFIX = ". You can now continue with the user's answers in mind.";
var OPENCODE_UNANSWERED = "Unanswered";
var KEY_SEPARATOR = "\0";
function isPlanModeQuestionActive(input) {
  if (input.compactionMode) return false;
  if (input.configured !== true) return false;
  return input.opencodeHasQuestion;
}
var pendingQuestions = /* @__PURE__ */ new Map();
function pendingKey(sessionKey2, questionToolCallId) {
  return `${sessionKey2}${KEY_SEPARATOR}${questionToolCallId}`;
}
function clearExitPlanModeQuestions(sessionKey2) {
  const prefix = `${sessionKey2}${KEY_SEPARATOR}`;
  for (const key of pendingQuestions.keys()) {
    if (key.startsWith(prefix)) pendingQuestions.delete(key);
  }
}
function hasExitPlanModeQuestions(sessionKey2) {
  const prefix = `${sessionKey2}${KEY_SEPARATOR}`;
  return [...pendingQuestions.keys()].some((key) => key.startsWith(prefix));
}
function createExitPlanModeQuestionCall(sessionKey2, exitPlanModeToolUseId, plan, questionToolCallId = `exit_plan_question_${exitPlanModeToolUseId}`) {
  pendingQuestions.set(pendingKey(sessionKey2, questionToolCallId), exitPlanModeToolUseId);
  return {
    toolCallId: questionToolCallId,
    toolName: QUESTION_TOOL_NAME,
    input: {
      questions: [
        {
          header: "Plan approval",
          question: PLAN_MODE_APPROVAL_QUESTION,
          options: [
            { label: "yes", description: "" },
            { label: "no", description: "" }
          ],
          multiple: false,
          custom: true
        }
      ]
    },
    text: plan ? `

${plan}
` : "\n\n"
  };
}
function buildToolResultMessage(input) {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        input.approved ? {
          type: "tool_result",
          tool_use_id: input.toolUseId,
          content: APPROVED_EXIT_PLAN_MODE_MESSAGE
        } : {
          type: "tool_result",
          tool_use_id: input.toolUseId,
          content: `${REJECTED_EXIT_PLAN_MODE_PREFIX}
${input.feedback || "no"}`,
          is_error: true
        }
      ]
    }
  });
}
function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function unwrapToolOutput(part) {
  const output = part?.output ?? part?.result;
  if (typeof output === "string") return tryParseJson(output);
  if (!output || typeof output !== "object") return output;
  switch (output.type) {
    case "json":
    case "error-json":
      return output.value;
    case "text":
    case "error-text":
      return tryParseJson(String(output.value ?? ""));
    case "execution-denied":
      return {
        denied: true,
        reason: String(output.reason ?? "question rejected")
      };
    case "content":
      return Array.isArray(output.value) ? output.value.map((item) => {
        if (item?.type === "text") return item.text;
        return JSON.stringify(item);
      }).join("\n") : output.value;
    default:
      return output;
  }
}
function unwrapOpencodeQuestionResult(value, question) {
  const sentence = value.trim();
  if (!sentence.startsWith(OPENCODE_QUESTION_RESULT_PREFIX) || !sentence.endsWith(OPENCODE_QUESTION_RESULT_SUFFIX)) {
    return value;
  }
  const body = sentence.slice(
    OPENCODE_QUESTION_RESULT_PREFIX.length,
    sentence.length - OPENCODE_QUESTION_RESULT_SUFFIX.length
  );
  if (!body.startsWith('"') || !body.endsWith('"')) return value;
  let answer;
  const head = question === void 0 ? void 0 : `"${question}"="`;
  if (head && body.startsWith(head) && body.length > head.length) {
    answer = body.slice(head.length, -1);
  } else {
    const split = body.lastIndexOf('"="');
    if (split > 0) answer = body.slice(split + 3, -1);
  }
  if (answer === void 0) return value;
  return answer === OPENCODE_UNANSWERED ? "" : answer;
}
function collectAnswerStrings(value, question) {
  if (typeof value === "string") return [unwrapOpencodeQuestionResult(value, question)];
  if (Array.isArray(value)) return value.flatMap((item) => collectAnswerStrings(item, question));
  if (!value || typeof value !== "object") return [];
  const obj = value;
  if (obj.denied === true) return [String(obj.reason ?? "question rejected")];
  for (const key of ["answers", "answer", "selected", "selection", "value"]) {
    if (key in obj) return collectAnswerStrings(obj[key], question);
  }
  return [];
}
function classifyQuestionResult(part) {
  const output = unwrapToolOutput(part);
  const answers = collectAnswerStrings(output, PLAN_MODE_APPROVAL_QUESTION).map((answer) => answer.trim()).filter(Boolean);
  if (answers.length === 1 && answers[0].toLowerCase() === "yes") {
    return { approved: true, feedback: "" };
  }
  return {
    approved: false,
    feedback: answers.length > 0 ? answers.join("\n") : "no"
  };
}
function consumeExitPlanModeQuestionResult(sessionKey2, prompt) {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i];
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part?.type !== "tool-result" || typeof part.toolCallId !== "string") {
        continue;
      }
      const key = pendingKey(sessionKey2, part.toolCallId);
      const exitPlanModeToolUseId = pendingQuestions.get(key);
      if (!exitPlanModeToolUseId) continue;
      pendingQuestions.delete(key);
      const result = classifyQuestionResult(part);
      return buildToolResultMessage({
        toolUseId: exitPlanModeToolUseId,
        approved: result.approved,
        feedback: result.feedback
      });
    }
  }
  return null;
}

// src/account-failover.ts
var FAILOVER_MARKER = "\u258C **account failover:**";
var ACCOUNT_FAILOVER_TOOL_CALL_PREFIX = "account_failover_";
var KEY_SEPARATOR2 = "\0";
var STOP_ANSWER = "stop";
var ACCOUNT_LIMIT_PATTERNS = [
  /third-party apps now draw from your extra usage/i,
  /you[’'`]?ve hit your individual spend limit/i
];
var ACCOUNT_BLOCK_MARKER = "\u258C **claude account:**";
var ACCOUNT_BLOCKS = {
  authentication_failed: { what: "is not logged in (its login expired or was revoked)", login: true },
  oauth_org_not_allowed: { what: "belongs to an organization that does not allow this login", login: false },
  account_on_hold: { what: "is on hold", login: false },
  verification_required: { what: "needs to be verified at claude.ai", login: false },
  billing_error: { what: "has a billing problem", login: false }
};
function accountBlockKind(msg) {
  if (msg.type !== "assistant" || typeof msg.error !== "string") return null;
  return Object.prototype.hasOwnProperty.call(ACCOUNT_BLOCKS, msg.error) ? msg.error : null;
}
function describeAccountBlock(kind) {
  return ACCOUNT_BLOCKS[kind].what;
}
function loginCommandFor(configDir, home = homedir2()) {
  if (!configDir) return "claude auth login";
  const shown = configDir === home || configDir.startsWith(`${home}/`) ? `~${configDir.slice(home.length)}` : configDir;
  return `CLAUDE_CONFIG_DIR=${shown} claude auth login`;
}
function formatAccountBlockNote(input) {
  const block = ACCOUNT_BLOCKS[input.kind];
  const account = normalizeAccountName(input.account || DEFAULT_ACCOUNT);
  const fix = block.login ? `Log in again with \`${loginCommandFor(input.configDir)}\`, then resend your message.` : "Check the account at claude.ai, then resend your message.";
  const then = input.offeringSwitch ? " Or pick another account below." : "";
  return `
${ACCOUNT_BLOCK_MARKER} the Claude account "${account}" ${block.what}. ${fix}${then}
`;
}
function isAccountLimitError(input) {
  if (input.rateLimit && isRateLimitRejected(input.rateLimit)) return true;
  const text = input.resultText;
  if (typeof text !== "string" || text.length === 0) return false;
  return ACCOUNT_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}
var accountOverrides = /* @__PURE__ */ new Map();
function setAccountOverride(source, target, until, now = Date.now()) {
  const from = normalizeAccountName(source || DEFAULT_ACCOUNT);
  const to = normalizeAccountName(target);
  if (!to || to === from) return;
  if (until !== void 0 && until <= now) {
    log.notice("ignoring a failover reset time that is not in the future", {
      source: from,
      target: to,
      until
    });
    until = void 0;
  }
  accountOverrides.set(from, { target: to, until });
  log.warn(
    `Claude account "${from}" is out of usage; this and every other session on it now runs on "${to}"${until ? ` until ${new Date(until).toISOString()}` : " until opencode restarts"}.`,
    { source: from, target: to, until: until ?? null }
  );
}
function resolveAccountOverride(source, now = Date.now()) {
  const from = normalizeAccountName(source || DEFAULT_ACCOUNT);
  const entry = accountOverrides.get(from);
  if (!entry) return void 0;
  if (entry.until !== void 0 && entry.until <= now) {
    accountOverrides.delete(from);
    log.notice(
      `Claude account "${from}" should have usage again; switching back from "${entry.target}".`,
      { source: from, target: entry.target, until: entry.until }
    );
    return void 0;
  }
  return entry.target;
}
function stripAccountSuffix(modelId) {
  const at = modelId.indexOf("@");
  return at === -1 ? modelId : modelId.slice(0, at);
}
async function resolveFailoverSpawn(input) {
  const unchanged = {
    cliPath: input.cliPath,
    modelId: input.modelId,
    failedOver: false
  };
  const source = normalizeAccountName(input.account || DEFAULT_ACCOUNT);
  const target = resolveAccountOverride(source, input.now);
  if (!target) return unchanged;
  try {
    const cliPath = target === DEFAULT_ACCOUNT ? input.baseCliPath : (await ensureAccountRuntime(target, input.baseCliPath)).cliPath;
    return {
      cliPath,
      modelId: stripAccountSuffix(input.modelId),
      target,
      failedOver: true
    };
  } catch (err) {
    log.error("failed to prepare the failover account runtime; staying put", {
      source,
      target,
      error: String(err)
    });
    return unchanged;
  }
}
function isAccountFailoverQuestionActive(input) {
  if (input.compactionMode) return false;
  if (input.interactive) return false;
  if (input.childSession) return false;
  if (input.configured === "off") return false;
  if (input.candidates.length === 0) return false;
  return input.opencodeHasQuestion;
}
function failoverCandidates(accounts, source) {
  const from = normalizeAccountName(source || DEFAULT_ACCOUNT);
  const out = [];
  for (const raw of accounts ?? []) {
    const name = normalizeAccountName(String(raw));
    if (!name || name === from || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}
var pendingQuestions2 = /* @__PURE__ */ new Map();
function pendingKey2(sessionKey2, toolCallId) {
  return `${sessionKey2}${KEY_SEPARATOR2}${toolCallId}`;
}
function clearAccountFailoverQuestions(sessionKey2) {
  const prefix = `${sessionKey2}${KEY_SEPARATOR2}`;
  for (const key of pendingQuestions2.keys()) {
    if (key.startsWith(prefix)) pendingQuestions2.delete(key);
  }
}
function describeReset(resetsAt) {
  return formatResetsAt(resetsAt);
}
function createAccountFailoverQuestionCall(sessionKey2, input, toolCallId = `${ACCOUNT_FAILOVER_TOOL_CALL_PREFIX}${Math.random().toString(36).slice(2, 10)}`) {
  const source = normalizeAccountName(input.sourceAccount || DEFAULT_ACCOUNT);
  const candidates = input.candidates.map((c) => normalizeAccountName(c));
  const resets = describeReset(input.resetsAt);
  const until = resets ?? "opencode restarts";
  const question = input.reason ? `The Claude account "${source}" ${input.reason}. Continue this task on another configured account? Leaving this unanswered waits, at no cost.` : [
    `The Claude account "${source}" is out of usage`,
    input.window ? ` in ${input.window}` : "",
    resets ? `, which resets at ${resets}` : "",
    ". Continue this task on another configured account? Leaving this unanswered waits, at no cost."
  ].join("");
  pendingQuestions2.set(pendingKey2(sessionKey2, toolCallId), {
    sourceAccount: source,
    candidates: [...candidates],
    resetsAt: input.resetsAt,
    question
  });
  return {
    toolCallId,
    toolName: QUESTION_TOOL_NAME,
    input: {
      questions: [
        {
          header: "Account limit",
          question,
          options: [
            ...candidates.map((candidate) => ({
              label: candidate,
              description: `Run on "${candidate}" until ${until}. The conversation is replayed as a fresh Claude session (a session cannot resume across accounts), and any MCP server configured only in "${source}"'s Claude profile will be missing.`
            })),
            {
              label: STOP_ANSWER,
              description: "End this turn now and leave the account as it is."
            }
          ],
          multiple: false,
          custom: true
        }
      ]
    },
    text: ""
  };
}
function isDenied(output) {
  return !!output && typeof output === "object" && output.denied === true;
}
function classify(pending, part) {
  const output = unwrapToolOutput(part);
  if (isDenied(output)) {
    return {
      kind: "stop",
      reason: String(output.reason ?? "question rejected")
    };
  }
  const outputType = part?.output?.type;
  if (outputType === "error-text" || outputType === "error-json") {
    return { kind: "stop", reason: String(output ?? "the form was dismissed") };
  }
  const answers = collectAnswerStrings(output, pending.question).map((answer) => answer.trim()).filter(Boolean);
  if (answers.length === 0) return { kind: "stop", reason: "no answer" };
  const picked = normalizeAccountName(answers[0]);
  if (picked === STOP_ANSWER) {
    return { kind: "stop", reason: "the operator chose to stop" };
  }
  const target = pending.candidates.find((candidate) => candidate === picked);
  if (!target) {
    return { kind: "stop", reason: `unrecognised answer "${answers[0]}"` };
  }
  return {
    kind: "switch",
    target,
    sourceAccount: pending.sourceAccount,
    resetsAt: pending.resetsAt
  };
}
function consumeAccountFailoverAnswer(sessionKey2, prompt, fallback) {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i];
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part?.type !== "tool-result" || typeof part.toolCallId !== "string") {
        continue;
      }
      const key = pendingKey2(sessionKey2, part.toolCallId);
      const pending = pendingQuestions2.get(key);
      if (!pending) continue;
      pendingQuestions2.delete(key);
      return classify(pending, part);
    }
  }
  const last = prompt[prompt.length - 1];
  if (fallback && fallback.candidates.length > 0 && Array.isArray(last?.content)) {
    const orphan = last.content.find(
      (part) => part?.type === "tool-result" && typeof part.toolCallId === "string" && part.toolCallId.startsWith(ACCOUNT_FAILOVER_TOOL_CALL_PREFIX)
    );
    if (orphan) {
      return classify(
        {
          sourceAccount: normalizeAccountName(fallback.sourceAccount || DEFAULT_ACCOUNT),
          candidates: fallback.candidates.map((c) => normalizeAccountName(c))
        },
        orphan
      );
    }
  }
  return null;
}
function formatFailoverNote(input) {
  const resets = describeReset(input.resetsAt);
  return `
${FAILOVER_MARKER} "${input.sourceAccount}" is out of usage, so this conversation continues on "${input.target}" ${resets ? `until ${resets}` : "until opencode restarts"}. Claude cannot resume a session across accounts, so the thread is being replayed into a fresh one.
`;
}
function formatFailoverStopNote(reason) {
  return `
${FAILOVER_MARKER} Staying on this account (${reason}). The turn ends here; the usage limit is unchanged.
`;
}
function isFailoverPart(part) {
  if (!part || typeof part.toolCallId !== "string") return false;
  if (part.type !== "tool-call" && part.type !== "tool-result") return false;
  return part.toolCallId.startsWith(ACCOUNT_FAILOVER_TOOL_CALL_PREFIX);
}
function stripAccountFailoverParts(prompt) {
  let changed = false;
  const out = [];
  for (const message of prompt) {
    const content = message.content;
    if (!Array.isArray(content) || !content.some(isFailoverPart)) {
      out.push(message);
      continue;
    }
    changed = true;
    const kept = content.filter((part) => !isFailoverPart(part));
    if (kept.length === 0) continue;
    out.push({ ...message, content: kept });
  }
  return changed ? out : prompt;
}
function failoverContinuationText(target) {
  return [
    `The Claude account this conversation was running on hit its usage limit, so it has been moved to the "${target}" account and you are now in a fresh Claude session.`,
    "The conversation so far is above. Continue the task from where it stopped: do not start over, do not re-plan, and do not repeat work that is already done.",
    "Do not mention the account switch unless you are asked about it."
  ].join(" ");
}
function buildFailoverContinuationPrompt(prompt, target) {
  const stripped = stripAccountFailoverParts(prompt);
  return [
    ...stripped,
    {
      role: "user",
      content: [{ type: "text", text: failoverContinuationText(target) }]
    }
  ];
}
function failoverUntil(resetsAt) {
  return resetsAtToMs(resetsAt);
}

// src/cli-version.ts
import { execFile } from "child_process";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
var cache = /* @__PURE__ */ new Map();
var CLI_HYGIENE_ENV_VARS = [
  "DISABLE_AUTOUPDATER",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
];
function cliHygieneEnv(inherited = process.env) {
  const filled = {};
  for (const name of CLI_HYGIENE_ENV_VARS) {
    if (inherited[name] === void 0) filled[name] = "1";
  }
  return filled;
}
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
function cliSupportsFastMode(v) {
  if (!v) return false;
  return gte(v, { major: 2, minor: 1, patch: 220 });
}
function cliSupportsRestricted(v) {
  if (!v) return false;
  return gte(v, { major: 2, minor: 1, patch: 258 });
}
function cliSupportsPermissionPrompts(v) {
  if (!v) return false;
  return gte(v, { major: 2, minor: 1, patch: 263 });
}
function cliSupportsSideQuestion(v) {
  if (!v) return false;
  return gte(v, { major: 2, minor: 1, patch: 258 });
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
      const execution = execFileAsync(cliPath, ["--help"], {
        timeout: 5e3,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024
      });
      execution.child.stdin?.end();
      const { stdout } = await execution;
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

// src/session-manager.ts
import { spawn } from "child_process";
import { createInterface } from "readline";
import { randomUUID as randomUUID3 } from "crypto";
import { EventEmitter as EventEmitter3 } from "events";
import { unlink } from "fs/promises";

// src/proxy-mcp.ts
import { createServer } from "http";
import * as fs2 from "fs";
import * as path3 from "path";
import * as crypto from "crypto";
import { EventEmitter } from "events";

// src/tmp.ts
import * as fs from "fs";
import * as os from "os";
import * as path2 from "path";
var PLUGIN_TMP_PREFIX = "opencode-claude-code-";
var PID_TMP_DIR = path2.join(
  os.tmpdir(),
  `${PLUGIN_TMP_PREFIX}${process.pid}`
);
var currentDir = null;
var createdDirs = /* @__PURE__ */ new Set();
var registered = false;
function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : void 0;
}
function untrustworthyReason(dir) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return "path is a symlink";
  if (!stat.isDirectory()) return "path is not a directory";
  const uid = currentUid();
  if (uid !== void 0 && stat.uid !== uid) {
    return `directory is owned by uid ${stat.uid}, not ${uid}`;
  }
  return null;
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 448 });
  try {
    fs.chmodSync(dir, 448);
  } catch {
  }
}
function chooseDir() {
  const reason = untrustworthyReason(PID_TMP_DIR);
  if (!reason) return PID_TMP_DIR;
  const fallback = fs.mkdtempSync(path2.join(os.tmpdir(), PLUGIN_TMP_PREFIX));
  log.warn("refusing the pid-named scratch directory", {
    path: PID_TMP_DIR,
    reason,
    fallback
  });
  return fallback;
}
function registerExitCleanup() {
  if (registered) return;
  registered = true;
  process.on("exit", () => {
    for (const dir of createdDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
      }
    }
  });
}
var PID_DIR_NAME = /^opencode-claude-code-(\d+)$/;
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function sweepStalePluginTmpDirs(keep) {
  const removed = [];
  if (process.env.OPENCODE_CLAUDE_CODE_NO_TMP_SWEEP === "1") return removed;
  const root = os.tmpdir();
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return removed;
  }
  const uid = currentUid();
  const keepPath = keep ? path2.resolve(keep) : null;
  for (const entry of entries) {
    const match = PID_DIR_NAME.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (pid === process.pid) continue;
    const dir = path2.join(root, entry);
    if (keepPath && path2.resolve(dir) === keepPath) continue;
    let stat;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (uid !== void 0 && stat.uid !== uid) continue;
    if (isProcessAlive(pid)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (err) {
      log.debug("could not remove a stale scratch directory", {
        dir,
        error: String(err)
      });
    }
  }
  if (removed.length > 0) {
    log.info("removed stale plugin scratch directories", {
      count: removed.length,
      dirs: removed
    });
  }
  return removed;
}
var swept = false;
function sweepOnce(keep) {
  if (swept) return;
  swept = true;
  try {
    sweepStalePluginTmpDirs(keep);
  } catch (err) {
    log.warn("stale scratch directory sweep failed", { error: String(err) });
  }
}
function pluginTmpDir() {
  if (currentDir === null || untrustworthyReason(currentDir) !== null) {
    currentDir = chooseDir();
  }
  ensureDir(currentDir);
  createdDirs.add(currentDir);
  registerExitCleanup();
  sweepOnce(currentDir);
  return currentDir;
}

// src/proxy-mcp.ts
var PROXY_KEEPALIVE_MS = 15e3;
function acceptsEventStream(acceptHeader) {
  return typeof acceptHeader === "string" && acceptHeader.toLowerCase().includes("text/event-stream");
}
var SERVER_CLOSED_MESSAGE = "proxy MCP server closed";
function isExpectedCleanupError(message) {
  return message.includes("timed out after") && message.includes("waiting for opencode to resolve") || message.includes("rejecting as orphaned") || message.includes("was orphaned by a new user turn") || message.includes("stream was aborted") || message.includes(SERVER_CLOSED_MESSAGE);
}
var PROTOCOL_VERSION = "2024-11-05";
var SERVER_NAME = PROXY_MCP_SERVER_NAME;
var PROXY_TOOL_PREFIX = `mcp__${SERVER_NAME}__`;
var PROXY_DEFAULT_TIMEOUT_MS = 10 * 60 * 1e3;
var PROXY_NO_DEADLINE_MS = 0;
var PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS = {
  task: PROXY_NO_DEADLINE_MS,
  task_batch: PROXY_NO_DEADLINE_MS,
  // same reasoning: it IS task calls
  question: 30 * 60 * 1e3
  // 30 min
};
var MAX_PROXY_TIMEOUT_MS = 2 ** 31 - 1;
function resolveProxyCallTimeoutMs(toolName, input, overrides) {
  const key = toolName.toLowerCase();
  let ms = PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS[key] ?? PROXY_DEFAULT_TIMEOUT_MS;
  if (overrides) {
    const ov = lookupCaseInsensitive(overrides, key);
    if (isDeadlineOverride(ov)) ms = ov;
  }
  if (key === "bash") {
    const requested = input?.timeout;
    if (typeof requested === "number" && requested > ms) ms = requested;
  }
  return Math.min(ms, MAX_PROXY_TIMEOUT_MS);
}
function isDeadlineOverride(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
  const consider = (deadlineMs) => {
    if (deadlineMs === PROXY_NO_DEADLINE_MS) return true;
    if (deadlineMs > ms) ms = deadlineMs;
    return false;
  };
  for (const [toolName, defaultMs] of Object.entries(PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS)) {
    const override = overrides ? lookupCaseInsensitive(overrides, toolName) : void 0;
    if (consider(isDeadlineOverride(override) ? override : defaultMs)) {
      return MAX_PROXY_TIMEOUT_MS;
    }
  }
  for (const value of Object.values(overrides ?? {})) {
    if (isDeadlineOverride(value) && consider(value)) return MAX_PROXY_TIMEOUT_MS;
  }
  return Math.min(ms, MAX_PROXY_TIMEOUT_MS);
}
var proxyDeadlineGuard = null;
function setProxyDeadlineGuard(guard) {
  proxyDeadlineGuard = guard;
}
var PROXY_DEADLINE_RECHECK_MS = 6e4;
var deadlineRecheckMs = PROXY_DEADLINE_RECHECK_MS;
function armProxyDeadline(opts) {
  let cancelled = false;
  let extended = false;
  let timer = null;
  const check = async () => {
    timer = null;
    if (cancelled) return;
    let keep = false;
    const guard = proxyDeadlineGuard;
    if (guard) {
      try {
        keep = await guard({ callId: opts.callId, toolName: opts.toolName });
      } catch {
        keep = false;
      }
    }
    if (cancelled) return;
    if (keep) {
      if (!extended && opts.logExtension) {
        log.warn("proxy call past its deadline, but opencode is still serving it; waiting", {
          callId: opts.callId,
          toolName: opts.toolName,
          deadlineMs: opts.deadlineMs,
          note: "usually a permission prompt in opencode; the call ends when it is answered, you abort, or the claude process goes"
        });
      }
      extended = true;
      timer = setTimeout(() => void check(), opts.recheckMs ?? deadlineRecheckMs);
      return;
    }
    opts.onExpire();
  };
  timer = setTimeout(() => void check(), opts.deadlineMs);
  return {
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}
function buildProxyTimeoutError(toolName, ms) {
  const key = toolName.toLowerCase();
  const base = `Proxy tool '${toolName}' timed out after ${ms}ms waiting for opencode to resolve the call`;
  if (key === "task" || key === TASK_BATCH_TOOL_NAME) {
    return new Error(
      base + (key === "task" ? " (the subagent)." : " (the subagents).") + " The subagent may still be running but its result is no longer reachable in this session. Do not declare the dispatch failed, and do not 'schedule a wake-up' or defer -- that mechanism does not apply here. If the result is required, re-dispatch or verify it directly now."
    );
  }
  return new Error(base);
}
var TASK_PROXY_NOTE = "This and task_batch are the ONLY tools that dispatch opencode subagents (including user @-mentions). Claude Code's built-in TaskCreate/TaskUpdate manage a local todo list and cannot dispatch subagents. Do not search config files to verify a subagent type exists: invalid types fail fast with a clear error. Foreground calls block until the subagent finishes; set `background` to request opencode's background execution mode. For two or more independent subagents in one response use task_batch, not several task calls: those run one after another. Task calls have no proxy deadline by default: the call waits for the subagent to finish (a positive proxyToolTimeoutMs override adds a deadline).";
var TASK_BATCH_TOOL_NAME = "task_batch";
var TASK_BATCH_PROXY_NOTE = "Use this instead of several task calls in one response: Claude Code runs MCP tool calls one at a time, so separate task calls run serially even when emitted together, while one task_batch call fans them out as parallel opencode task calls. Each task takes the same fields as the task tool. Results come back in task order, each labelled. Like task it has no proxy deadline by default (a positive proxyToolTimeoutMs override adds one).";
var TASK_INPUT_REQUIRED = ["description", "prompt", "subagent_type"];
function taskBatchInputError(input) {
  const tasks = input?.tasks;
  if (!Array.isArray(tasks) || tasks.length < 2) {
    return "task_batch requires a `tasks` array with at least two items; use `task` for one subagent";
  }
  for (const [index, task] of tasks.entries()) {
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
function taskBatchTasks(input) {
  if (taskBatchInputError(input)) return [];
  return input.tasks;
}
function taskBatchChildToolCallId(parentToolCallId, index) {
  return `${parentToolCallId}_task_${index}`;
}
function formatTaskBatchResults(children) {
  const total = children.length;
  const sections = children.map(({ task, result }, index) => {
    const label = typeof task.description === "string" ? task.description : `task ${index + 1}`;
    const agent = typeof task.subagent_type === "string" ? ` (${task.subagent_type})` : "";
    const header = `## task ${index + 1} of ${total}: ${label}${agent}`;
    if (!result) return `${header}
[missing] opencode returned no result for this task in the batch`;
    if (result.kind === "error") return `${header}
[error] ${result.message}`;
    return `${header}
${result.isError ? "[error] " : ""}${result.text}`;
  });
  const failed = children.some(({ result }) => !result || result.kind === "error" || result.isError);
  return { kind: "text", text: sections.join("\n\n"), ...failed ? { isError: true } : {} };
}
var AGENT_TYPES_HEADING = "Available agent types";
var AGENT_BLURB_LIMIT = 140;
var QUESTION_PROXY_NOTE = "This routes structured questions through opencode's native `question` tool, which renders a TUI form with the options you provide and blocks until the operator answers. Claude Code's built-in AskUserQuestion is disabled in this environment; this proxy is the ONLY way to ask the operator for a decision or clarification. Answers come back as arrays of selected labels (set `multiple: true` to allow more than one). If the operator dismisses the form the call returns an error \u2014 treat that as 'no answer' and stop, do not guess. Question calls get a 30-minute proxy deadline by default (configurable via proxyToolTimeoutMs); for long-AFK scenarios prefer fewer, high-signal questions.";
var COMPRESS_PROXY_NOTE = "The current turn continues normally after this call \u2014 finish what you are doing. The reset happens at the START of the next turn: the Claude Code session is discarded and a fresh one begins with your summary as its only prior context. Everything else, including tool output and files you read, is gone, so write the summary as the authoritative record. Call this once per compression, when older resolved work no longer needs full detail.";
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
    (t) => t.name === "task" || t.name === TASK_BATCH_TOOL_NAME ? { ...t, description: `${agentTypes}

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
    description: "Set this only if you mean to resume a previous task: pass the prior task_id to continue the same subagent session instead of creating a fresh one."
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
    description: "Launch an opencode subagent to handle a complex multi-step task autonomously. Routed through opencode's task tool so subagent orchestration, permission, and lifecycle are handled by opencode. Use `subagent_type` to pick which configured subagent runs (e.g. `build`, `general`, `explore`, or any custom subagent declared in opencode.json). " + TASK_PROXY_NOTE,
    inputSchema: {
      type: "object",
      properties: TASK_INPUT_PROPERTIES,
      required: TASK_INPUT_REQUIRED
    }
  },
  {
    name: TASK_BATCH_TOOL_NAME,
    description: "Launch two or more independent opencode subagents at the same time and get all their results back together. Put one ordinary task input in `tasks` for each subagent. " + TASK_BATCH_PROXY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 2,
          description: "Independent subagent tasks to run concurrently",
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
  },
  {
    name: "compress",
    description: "Replace older conversation detail with a summary you write, then continue in a fresh Claude Code session. Handled inside the plugin, so it never prompts the operator. " + COMPRESS_PROXY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Dense technical summary of the work being compressed: decisions made, files changed, commands run and their outcomes, and what is still open. This is the ONLY prior context that survives, so anything omitted is lost."
        }
      },
      required: ["summary"]
    }
  }
];
async function createProxyMcpServer(tools = DEFAULT_PROXY_TOOLS, timeoutOverrides, interceptors, options = {}) {
  const calls = new EventEmitter();
  const pending = /* @__PURE__ */ new Map();
  const keepaliveMs = options.keepaliveMs ?? PROXY_KEEPALIVE_MS;
  const authToken = crypto.randomBytes(32).toString("hex");
  const expectedAuth = Buffer.from(`Bearer ${authToken}`);
  let boundAuthority = "";
  function authOk(req) {
    const got = req.headers.authorization;
    if (typeof got !== "string") return false;
    const candidate = Buffer.from(got);
    if (candidate.length !== expectedAuth.length) return false;
    return crypto.timingSafeEqual(candidate, expectedAuth);
  }
  function reject(req, res, statusCode, reason) {
    log.notice("proxy-mcp rejected a request", {
      statusCode,
      reason,
      method: req.method,
      hasAuthorization: typeof req.headers.authorization === "string"
    });
    res.statusCode = statusCode;
    res.setHeader("Connection", "close");
    res.on("finish", () => {
      req.socket?.destroy();
    });
    res.end();
  }
  const server2 = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
      reject(req, res, 404, "not a POST to /mcp");
      return;
    }
    if (req.headers.host !== boundAuthority) {
      reject(req, res, 403, "host header is not the bound authority");
      return;
    }
    if (req.headers.origin !== void 0) {
      reject(req, res, 403, "origin header present");
      return;
    }
    const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      reject(req, res, 415, "content-type is not application/json");
      return;
    }
    if (!authOk(req)) {
      reject(req, res, 401, "missing or invalid bearer token");
      return;
    }
    let requestId = null;
    let requestMethod = null;
    let reply = null;
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
          const problem = taskBatchInputError(input);
          if (problem) {
            writeToolCallResult(res, requestId, { kind: "error", message: problem });
            return;
          }
        }
        const interceptor = interceptors?.get(toolName);
        if (interceptor) {
          let intercepted;
          try {
            intercepted = await interceptor(input);
          } catch (interceptorError) {
            const message = interceptorError instanceof Error ? interceptorError.message : String(interceptorError);
            log.warn("proxy-mcp interceptor failed", { toolName, error: message });
            intercepted = { kind: "error", message };
          }
          writeToolCallResult(res, requestId, intercepted);
          return;
        }
        const callId = crypto.randomUUID();
        log.info("proxy-mcp tool call received", {
          callId,
          toolName,
          hasInput: input != null,
          sse: acceptsEventStream(req.headers.accept)
        });
        const channel = { closed: false };
        reply = acceptsEventStream(req.headers.accept) ? openEventStream(res, keepaliveMs) : openJsonStream(res, keepaliveMs);
        res.once("close", () => {
          reply?.stop();
          if (res.writableFinished) return;
          channel.closed = true;
          log.notice("proxy-mcp client closed a tool call before its result", {
            callId,
            toolName
          });
        });
        let timer = null;
        const result = await new Promise(
          (resolve6, reject2) => {
            const entry = {
              id: callId,
              toolName,
              input,
              resolve: resolve6,
              reject: reject2,
              channel
            };
            pending.set(callId, entry);
            const deadlineMs = resolveProxyCallTimeoutMs(
              toolName,
              input,
              timeoutOverrides
            );
            if (deadlineMs > PROXY_NO_DEADLINE_MS) {
              timer = armProxyDeadline({
                callId,
                toolName,
                deadlineMs,
                onExpire: () => {
                  if (!pending.has(callId)) return;
                  pending.delete(callId);
                  log.notice("proxy-mcp tool call timed out", {
                    callId,
                    toolName,
                    deadlineMs
                  });
                  reject2(buildProxyTimeoutError(toolName, deadlineMs));
                }
              });
            }
            calls.emit("call", entry);
          }
        ).finally(() => {
          timer?.cancel();
          pending.delete(callId);
        });
        if (channel.closed) {
          log.notice("proxy-mcp dropping result for a closed tool call", {
            callId,
            toolName
          });
          return;
        }
        writeToolCallResult(res, requestId, result, reply);
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
          writeToolCallResult(
            res,
            requestId,
            { kind: "error", message: errorMessage },
            reply
          );
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
  await new Promise((resolve6, reject2) => {
    server2.once("error", reject2);
    server2.listen(0, "127.0.0.1", () => {
      server2.off("error", reject2);
      resolve6();
    });
  });
  const addr = server2.address();
  if (!addr) {
    server2.close();
    throw new Error("Failed to bind proxy MCP server");
  }
  boundAuthority = `127.0.0.1:${addr.port}`;
  const url = `http://${boundAuthority}/mcp`;
  log.info("proxy-mcp server started", {
    url,
    tools: tools.map((t) => t.name)
  });
  let configFilePath = null;
  const api = {
    url,
    serverName: SERVER_NAME,
    tools,
    authToken,
    calls,
    configPath() {
      if (configFilePath) return configFilePath;
      const body = JSON.stringify(
        {
          mcpServers: {
            [SERVER_NAME]: {
              type: "http",
              url,
              // Claude CLI replays these headers on every request to this
              // server, which is what lets the handler above reject anyone
              // who did not read this 0600 file.
              headers: { Authorization: `Bearer ${authToken}` },
              timeout: resolveProxyClientCeilingMs(timeoutOverrides)
            }
          }
        },
        null,
        2
      );
      const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 12);
      const outPath = path3.join(
        pluginTmpDir(),
        `proxy-${hash}.json`
      );
      fs2.writeFileSync(outPath, body, { encoding: "utf8", mode: 384 });
      configFilePath = outPath;
      return outPath;
    },
    pendingCallIds() {
      return [...pending.keys()];
    },
    async close() {
      for (const entry of pending.values()) {
        entry.reject(new Error(SERVER_CLOSED_MESSAGE));
      }
      pending.clear();
      await new Promise((resolve6) => {
        server2.close(() => resolve6());
      });
      if (configFilePath) {
        try {
          fs2.unlinkSync(configFilePath);
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
function resolveDisallowedTools(options) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (name) => {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  for (const name of disallowedToolFlags(options.proxyTools ?? [])) push(name);
  for (const name of options.extraDisallowedTools ?? []) push(String(name));
  if (options.disableWebSearch) push("WebSearch");
  return out;
}
function resolveProxyOpencodeToolDefs(options) {
  const requested = options.requested ?? [];
  if (requested.length === 0) return [];
  const items = options.items;
  if (!items) {
    log.warn(
      "proxyOpencodeTools is set but opencode's tool registry did not answer; forwarding nothing this spawn",
      { requested: requested.map(String) }
    );
    return [];
  }
  const byLowerId = /* @__PURE__ */ new Map();
  for (const item of items) {
    const key = item.id.toLowerCase();
    if (!byLowerId.has(key)) byLowerId.set(key, item);
  }
  const taken = options.taken ?? /* @__PURE__ */ new Set();
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const unknown = [];
  const collided = [];
  for (const raw of requested) {
    const name = String(raw).trim();
    if (!name) continue;
    const item = byLowerId.get(name.toLowerCase());
    if (!item) {
      unknown.push(name);
      continue;
    }
    if (taken.has(item.id)) {
      collided.push(item.id);
      continue;
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({
      name: item.id,
      description: typeof item.description === "string" ? item.description : "",
      inputSchema: item.parameters && typeof item.parameters === "object" ? item.parameters : { type: "object", properties: {} }
    });
  }
  if (unknown.length > 0) {
    log.warn("ignoring unknown proxyOpencodeTools entries", {
      unknown,
      known: [...byLowerId.values()].map((item) => item.id).join(", ")
    });
  }
  if (collided.length > 0) {
    log.warn(
      "proxyOpencodeTools entry dropped: a proxy tool already holds that name, and it keeps it",
      { collided }
    );
  }
  return out;
}
function resolveMcpProxyToolDefs(options) {
  const empty = { defs: [], coveredServers: /* @__PURE__ */ new Set() };
  const serverNames = options.serverNames ?? [];
  if (serverNames.length === 0) return empty;
  const tools = options.tools;
  if (!tools || tools.length === 0) return empty;
  const serversByLengthDesc = [...serverNames].sort((a, b) => b.length - a.length);
  const taken = options.taken ?? /* @__PURE__ */ new Set();
  const defs = [];
  const coveredServers = /* @__PURE__ */ new Set();
  const seen = /* @__PURE__ */ new Set();
  const collided = [];
  for (const tool of tools) {
    if (tool?.type !== void 0 && tool.type !== "function") continue;
    const name = typeof tool?.name === "string" ? tool.name.trim() : "";
    if (!name) continue;
    const matchedServer = serversByLengthDesc.find(
      (server2) => name === server2 || name.startsWith(`${server2}_`)
    );
    if (!matchedServer) continue;
    if (seen.has(name)) continue;
    if (taken.has(name)) {
      collided.push(name);
      continue;
    }
    seen.add(name);
    coveredServers.add(matchedServer);
    defs.push({
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} }
    });
  }
  if (collided.length > 0) {
    log.warn(
      "MCP tool not routed through the proxy: another proxy tool already holds that name, and it keeps it",
      { collided }
    );
  }
  return { defs, coveredServers };
}
function readBody(req) {
  return new Promise((resolve6, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve6(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function writeToolCallResult(res, requestId, result, reply = null) {
  const text = result.kind === "error" ? result.message : result.text;
  const isError = result.kind === "error" || result.isError === true;
  const envelope = {
    jsonrpc: "2.0",
    id: requestId ?? null,
    result: {
      content: [{ type: "text", text }],
      isError
    }
  };
  if (reply) {
    reply.finish(envelope);
    return;
  }
  writeJson(res, envelope);
}
function startKeepalive(res, keepaliveMs, ping) {
  let timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      stop();
      return;
    }
    res.write(ping);
  }, keepaliveMs);
  timer.unref?.();
  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  return stop;
}
function openEventStream(res, keepaliveMs) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(": open\n\n");
  const stop = startKeepalive(res, keepaliveMs, ": keepalive\n\n");
  return {
    stop,
    finish(envelope) {
      stop();
      if (res.writableEnded || res.destroyed) return;
      res.end(`event: message
data: ${JSON.stringify(envelope)}

`);
    }
  };
}
function openJsonStream(res, keepaliveMs) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.flushHeaders();
  const stop = startKeepalive(res, keepaliveMs, " ");
  return {
    stop,
    finish(envelope) {
      stop();
      if (res.writableEnded || res.destroyed) return;
      res.end(JSON.stringify(envelope));
    }
  };
}
function writeJson(res, body) {
  if (res.destroyed || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(payload).toString());
  res.end(payload);
}

// src/proxy-broker.ts
import { EventEmitter as EventEmitter2 } from "events";
var PROXY_STALL_WARNING_MS = 5 * 6e4;
var PROXY_DEADLINE_WARNING_FRACTION = 0.6;
var PROXY_DEADLINE_WARNING_MIN_MS = 6e4;
function clearPendingTimers(pending) {
  pending.timer?.cancel();
  if (pending.stallTimer) clearInterval(pending.stallTimer);
  if (pending.deadlineWarnTimer) clearTimeout(pending.deadlineWarnTimer);
}
var pendingByCallId = /* @__PURE__ */ new Map();
var callIdsBySession = /* @__PURE__ */ new Map();
var emitter = new EventEmitter2();
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
function queuePendingProxyCall(sessionKey2, call, timeoutOverrides, stallWarningMs = PROXY_STALL_WARNING_MS, deadlineWarningMinMs = PROXY_DEADLINE_WARNING_MIN_MS) {
  const previous = pendingByCallId.get(call.id);
  if (previous) {
    clearPendingTimers(previous);
    previous.reject(
      new Error(`Replaced pending proxy call ${call.id} with a fresh one`)
    );
    pendingByCallId.delete(call.id);
    indexRemove(previous.sessionKey, call.id);
  }
  const deadlineMs = resolveProxyCallTimeoutMs(
    call.toolName,
    call.input,
    timeoutOverrides
  );
  const timer = deadlineMs > PROXY_NO_DEADLINE_MS ? armProxyDeadline({
    callId: call.id,
    toolName: call.toolName,
    deadlineMs,
    logExtension: true,
    onExpire: () => {
      const current = pendingByCallId.get(call.id);
      if (!current) return;
      pendingByCallId.delete(call.id);
      indexRemove(current.sessionKey, call.id);
      clearPendingTimers(current);
      current.reject(buildProxyTimeoutError(call.toolName, deadlineMs));
      log.notice("timed out pending proxy call", {
        sessionKey: current.sessionKey,
        toolCallId: call.id,
        toolName: call.toolName,
        deadlineMs
      });
    }
  }) : null;
  const stallTimer = deadlineMs === PROXY_NO_DEADLINE_MS && stallWarningMs > 0 ? setInterval(() => {
    const current = pendingByCallId.get(call.id);
    if (!current) return;
    log.warn("proxy call still waiting, no deadline", {
      sessionKey: current.sessionKey,
      toolCallId: current.toolCallId,
      toolName: current.toolName,
      waitedMs: Date.now() - current.createdAt,
      emitted: current.emitted === true,
      channelClosed: current.channel?.closed === true,
      note: "nothing will time this out; it ends when opencode returns a result, you abort, you send another message, or the claude process goes"
    });
  }, stallWarningMs) : null;
  stallTimer?.unref?.();
  const warnAtMs = Math.floor(deadlineMs * PROXY_DEADLINE_WARNING_FRACTION);
  const deadlineWarnTimer = deadlineMs >= deadlineWarningMinMs && deadlineMs > 0 && warnAtMs > 0 ? setTimeout(() => {
    const current = pendingByCallId.get(call.id);
    if (!current) return;
    const waitedMs = Date.now() - current.createdAt;
    log.warn("proxy call still waiting, deadline approaching", {
      sessionKey: current.sessionKey,
      toolCallId: current.toolCallId,
      toolName: current.toolName,
      waitedMs,
      deadlineMs,
      remainingMs: Math.max(0, deadlineMs - waitedMs),
      emitted: current.emitted === true,
      channelClosed: current.channel?.closed === true,
      note: "it will be rejected when the deadline passes unless opencode is still serving it (a permission prompt is waiting); raise this tool's proxyToolTimeoutMs if the work is legitimately this long"
    });
  }, warnAtMs) : null;
  deadlineWarnTimer?.unref?.();
  const pending = {
    sessionKey: sessionKey2,
    toolCallId: call.id,
    toolName: call.toolName,
    input: call.input,
    channel: call.channel,
    createdAt: Date.now(),
    deadlineMs,
    timer,
    stallTimer,
    deadlineWarnTimer,
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
function markPendingProxyCallEmitted(toolCallId) {
  const pending = pendingByCallId.get(toolCallId);
  if (pending) pending.emitted = true;
}
function isPendingProxyCallChannelClosed(call) {
  return call.channel?.closed === true;
}
function findPendingProxyCall(toolCallId) {
  return pendingByCallId.get(toolCallId);
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
function snapshotPendingProxyCalls(now = Date.now()) {
  const out = [];
  for (const pending of pendingByCallId.values()) {
    out.push({
      sessionKey: pending.sessionKey,
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
      ageMs: Math.max(0, now - pending.createdAt),
      deadlineMs: pending.deadlineMs,
      emitted: pending.emitted === true,
      channelClosed: pending.channel?.closed === true
    });
  }
  return out;
}
function resolvePendingProxyCallById(toolCallId, result) {
  const pending = pendingByCallId.get(toolCallId);
  if (!pending) return false;
  pendingByCallId.delete(toolCallId);
  indexRemove(pending.sessionKey, toolCallId);
  clearPendingTimers(pending);
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
  clearPendingTimers(pending);
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

// src/todo-ledger.ts
var ledgers = /* @__PURE__ */ new Map();
var PENDING_CREATE_TTL_MS = 6e4;
var MAX_LEDGER_SESSIONS = 64;
var TASK_CREATED_PATTERN = /Task\s*#?\s*(\d+)\s+created/i;
var VALID_STATUSES = /* @__PURE__ */ new Set(["pending", "in_progress", "completed"]);
function getOrCreate(sessionId) {
  let ledger = ledgers.get(sessionId);
  if (!ledger) {
    ledger = { todos: /* @__PURE__ */ new Map(), pendingCreates: /* @__PURE__ */ new Map() };
    ledgers.set(sessionId, ledger);
    capLedgers();
  }
  return ledger;
}
function capLedgers() {
  while (ledgers.size > MAX_LEDGER_SESSIONS) {
    const oldest = ledgers.keys().next();
    if (oldest.done) break;
    ledgers.delete(oldest.value);
    log.info("todo ledger evicted oldest session", { sessionId: oldest.value });
  }
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

// src/compression-store.ts
var MAX_COMPRESSION_ENTRIES = 32;
var compressions = /* @__PURE__ */ new Map();
function storeCompressionSummary(sessionKey2, summary) {
  compressions.set(sessionKey2, { summary, restartPending: true });
  while (compressions.size > MAX_COMPRESSION_ENTRIES) {
    const oldest = compressions.keys().next();
    if (oldest.done) break;
    compressions.delete(oldest.value);
    log.info("compression store evicted oldest entry", { sessionKey: oldest.value });
  }
}
function getCompressionSummary(sessionKey2) {
  return compressions.get(sessionKey2)?.summary;
}
function consumeCompressionRestart(sessionKey2) {
  const state = compressions.get(sessionKey2);
  if (!state?.restartPending) return false;
  state.restartPending = false;
  return true;
}
function clearCompression(sessionKey2) {
  compressions.delete(sessionKey2);
}

// src/permission-presets.ts
var READ_ONLY_DISALLOWED_CLI_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "REPL",
  "JavaScript",
  "WebFetch"
];
var READ_ONLY_DENIED_PROXY_TOOLS = /* @__PURE__ */ new Set([
  "bash",
  "write",
  "edit",
  "webfetch",
  "task",
  "task_batch"
]);
function dedupe(names) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const name of names) {
    const trimmed = String(name).trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
function resolveReadOnly(settings, defaultProxyTools) {
  const overridden = [];
  if (settings.permissionMode !== void 0) {
    overridden.push(
      `permissionMode: "${settings.permissionMode}" is dropped; read-only sends --restricted instead, which is stricter than every mode except plan and incompatible with bypassPermissions`
    );
  }
  if (settings.skipPermissions === true) {
    overridden.push(
      'skipPermissions: forced to false; the CLI exits with "bypassPermissions not supported in restricted mode" when both are passed'
    );
  }
  if (settings.controlRequestBehavior === "allow") {
    overridden.push(
      'controlRequestBehavior: forced to "deny"; read-only answers every permission request the same way the CLI does under --permission-prompts none'
    );
  }
  if (settings.controlRequestToolBehaviors !== void 0) {
    overridden.push(
      "controlRequestToolBehaviors: ignored; a per-tool allow would apply only on CLIs older than 2.1.263, so the preset would mean different things on different versions"
    );
  }
  const requested = settings.proxyTools ?? defaultProxyTools;
  const proxyTools = dedupe(requested).filter(
    (name) => !READ_ONLY_DENIED_PROXY_TOOLS.has(name.toLowerCase())
  );
  const dropped = dedupe(requested).filter(
    (name) => READ_ONLY_DENIED_PROXY_TOOLS.has(name.toLowerCase())
  );
  if (dropped.length > 0) {
    overridden.push(
      `proxyTools: dropped ${dropped.join(", ")}; those execute in opencode, where no Claude CLI flag reaches them`
    );
  }
  return {
    preset: "read-only",
    permissionMode: READ_ONLY_PERMISSION_MODE,
    skipPermissions: false,
    proxyTools,
    extraDisallowedTools: dedupe([
      ...READ_ONLY_DISALLOWED_CLI_TOOLS,
      ...settings.extraDisallowedTools ?? []
    ]),
    controlRequestBehavior: "deny",
    controlRequestToolBehaviors: void 0,
    overridden
  };
}
function resolvePermissionPreset(settings, defaultProxyTools) {
  const preset = settings.permissionPreset;
  if (preset === void 0) return null;
  if (preset === "read-only") return resolveReadOnly(settings, defaultProxyTools);
  return { unknown: String(preset) };
}
function isUnknownPreset(resolved) {
  return resolved !== null && "unknown" in resolved;
}
var NO_PERMISSION_PRESET = "none";
function summarizePermissionPreset(provider, options, defaultProxyTools = DEFAULT_PROXY_TOOL_NAMES) {
  const settings = options !== null && typeof options === "object" && !Array.isArray(options) ? options : {};
  const resolved = resolvePermissionPreset(settings, defaultProxyTools);
  if (resolved === null) {
    return { provider, preset: NO_PERMISSION_PRESET, applied: false, overrides: [] };
  }
  if (isUnknownPreset(resolved)) {
    return { provider, preset: resolved.unknown, applied: false, overrides: [] };
  }
  return {
    provider,
    preset: resolved.preset,
    applied: true,
    overrides: resolved.overridden
  };
}
function isReadOnlyPermissionMode(mode) {
  return mode === READ_ONLY_PERMISSION_MODE;
}

// src/side-question.ts
import { randomUUID as randomUUID2 } from "crypto";
var MAX_HISTORY_EXCHANGES = 20;
var SIDE_QUESTION_USAGE = "Usage: /btw <question>. Ask a side question about the current conversation without adding it to the main context.";
var pendingProcesses = /* @__PURE__ */ new WeakSet();
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
var SYSTEM_REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
function parseSideQuestionContent(content) {
  let text;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (!isRecord2(part) || part.type !== "text" || typeof part.text !== "string") return null;
      parts.push(part.text);
    }
    text = parts.join("\n");
  } else {
    return null;
  }
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.replace(SYSTEM_REMINDER_BLOCK, "").trim());
  return match ? { question: (match[1] ?? "").trim() } : null;
}
function parseSideQuestion(prompt) {
  const latest = prompt.at(-1);
  return latest?.role === "user" ? parseSideQuestionContent(latest.content) : null;
}
function assistantText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (isRecord2(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n").trim();
}
function collectSideQuestionHistory(prompt) {
  const history = [];
  for (let index = 0; index < prompt.length - 1; index++) {
    const message = prompt[index];
    if (message.role !== "user") continue;
    const aside = parseSideQuestionContent(message.content);
    if (!aside?.question) continue;
    const reply = prompt[index + 1];
    if (reply.role !== "assistant") continue;
    const response = assistantText(reply.content);
    if (!response || response === SIDE_QUESTION_USAGE) continue;
    history.push({ question: aside.question, response });
  }
  return history.slice(-MAX_HISTORY_EXCHANGES);
}
function isSideQuestionPending(activeProcess) {
  return pendingProcesses.has(activeProcess.proc);
}
function dispatchSideQuestionResponse(activeProcess, line) {
  if (!pendingProcesses.has(activeProcess.proc)) return false;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return false;
  }
  if (!isRecord2(message) || message.type !== "control_response") return false;
  const response = message.response;
  if (!isRecord2(response) || typeof response.request_id !== "string") return false;
  return activeProcess.lineEmitter.emit(`side-question:${response.request_id}`, response);
}
async function requestSideQuestion(activeProcess, question, options) {
  question = question.trim();
  if (!question) return { response: SIDE_QUESTION_USAGE, synthetic: true };
  options.abortSignal?.throwIfAborted();
  const { proc, lineEmitter } = activeProcess;
  if (options.interactive || !proc.stdout) {
    throw new Error("/btw requires the headless Claude Code transport; interactive sessions are not supported.");
  }
  if (!cliSupportsSideQuestion(options.cliVersion)) {
    throw new Error("/btw requires Claude Code CLI 2.1.258 or newer (the oldest verified version).");
  }
  if (pendingProcesses.has(proc)) {
    throw new Error("Wait for the current /btw to finish before asking another.");
  }
  const stdin = proc.stdin;
  if (proc.killed || proc.exitCode != null || proc.signalCode != null || !stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) {
    throw new Error("/btw requires a live Claude Code session with writable stdin.");
  }
  const timeoutMs = options.timeoutMs ?? 12e4;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new Error("/btw timeoutMs must be a positive 32-bit integer.");
  }
  const requestId = randomUUID2();
  const request = JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "side_question",
      question,
      ...options.history === void 0 ? {} : { history: options.history }
    }
  });
  pendingProcesses.add(proc);
  return new Promise((resolve6, reject) => {
    const event = `side-question:${requestId}`;
    let settled = false;
    let sent = false;
    let cancelPending = false;
    const cleanup = () => {
      clearTimeout(timer);
      lineEmitter.off(event, onResponse);
      lineEmitter.off("close", onClose);
      lineEmitter.off("error", onError);
      proc.off("exit", onClose);
      proc.off("close", onClose);
      proc.off("error", onError);
      if (!cancelPending) stdin.off("error", onError);
      options.abortSignal?.removeEventListener("abort", onAbort);
      pendingProcesses.delete(proc);
    };
    const fail = (error, cancel = false) => {
      if (settled) return;
      settled = true;
      if (cancel && sent && !stdin.destroyed && !stdin.writableEnded && stdin.writable) {
        try {
          cancelPending = true;
          stdin.write(
            JSON.stringify({ type: "control_cancel_request", request_id: requestId }) + "\n",
            () => {
              queueMicrotask(() => stdin.off("error", onError));
            }
          );
        } catch {
          cancelPending = false;
        }
      }
      cleanup();
      reject(error);
    };
    const onClose = () => fail(new Error("Claude Code closed before answering /btw."));
    const onError = (error) => fail(error);
    const onAbort = () => fail(
      options.abortSignal?.reason ?? new DOMException("/btw was aborted.", "AbortError"),
      true
    );
    const onResponse = (response) => {
      if (settled || response.request_id !== requestId) return;
      if (response.subtype === "error") {
        fail(new Error(typeof response.error === "string" ? response.error : "Claude Code rejected /btw."));
        return;
      }
      const result = response.response;
      if (response.subtype !== "success" || !isRecord2(result) || typeof result.response !== "string" || typeof result.synthetic !== "boolean") {
        fail(new Error("Claude Code returned an invalid /btw response."));
        return;
      }
      settled = true;
      cleanup();
      resolve6({ response: result.response, synthetic: result.synthetic });
    };
    const timer = setTimeout(() => {
      fail(new Error(`/btw timed out after ${timeoutMs}ms.`), true);
    }, timeoutMs);
    lineEmitter.on(event, onResponse);
    lineEmitter.on("close", onClose);
    lineEmitter.on("error", onError);
    proc.on("exit", onClose);
    proc.on("close", onClose);
    proc.on("error", onError);
    stdin.on("error", onError);
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (options.abortSignal?.aborted) {
      onAbort();
      return;
    }
    try {
      sent = true;
      stdin.write(request + "\n");
    } catch (error) {
      fail(error);
    }
  });
}

// src/session-manager.ts
function findActiveProcessBySessionId(sessionID) {
  let found;
  for (const ap of activeProcesses.values()) {
    if (ap.opencodeSessionID === sessionID) found = ap;
  }
  return found;
}
var UNATTENDED_LINE_CAP = 500;
var UNATTENDED_BYTE_CAP = 2 * 1024 * 1024;
function bufferUnattendedLine(ap, line) {
  const lines = ap.unattendedLines ??= [];
  lines.push(line);
  let bytes = 0;
  for (const kept of lines) bytes += Buffer.byteLength(kept);
  while (lines.length > 0 && (lines.length > UNATTENDED_LINE_CAP || bytes > UNATTENDED_BYTE_CAP)) {
    bytes -= Buffer.byteLength(lines.shift());
    ap.unattendedDropped = (ap.unattendedDropped ?? 0) + 1;
  }
}
function takeUnattendedLines(ap) {
  const lines = ap.unattendedLines ?? [];
  const dropped = ap.unattendedDropped ?? 0;
  ap.unattendedLines = [];
  ap.unattendedDropped = 0;
  return { lines, dropped };
}
var STDERR_RETAIN_BYTES = 2 * 1024;
function retainStderr(ap, chunk) {
  ap.lastStderr = ((ap.lastStderr ?? "") + chunk).slice(-STDERR_RETAIN_BYTES);
}
function describeChildCrash(exitCode, signal, lastStderr) {
  const how = signal ? `was killed by ${signal}` : typeof exitCode === "number" ? `exited with code ${exitCode}` : "closed its output";
  const tail = lastStderr?.trim();
  return `The Claude Code CLI ${how} before finishing this turn (no result was emitted), so the answer above may be incomplete.` + (tail ? `

Last stderr from the CLI:
${tail}` : "");
}
var activeProcesses = /* @__PURE__ */ new Map();
var claudeSessions = /* @__PURE__ */ new Map();
var idleEvictionTimers = /* @__PURE__ */ new Map();
var MAX_IDLE_TIMEOUT_MS = 2147483647;
var DEFAULT_IDLE_PROCESS_TIMEOUT_MS = 0;
function resolveIdleProcessTimeoutMs(configured) {
  return configured === void 0 ? DEFAULT_IDLE_PROCESS_TIMEOUT_MS : configured;
}
var MAX_ACTIVE_PROCESSES = 16;
var PROCESS_EXIT_TIMEOUT_MS = 1500;
var PROCESS_FORCE_EXIT_TIMEOUT_MS = 500;
var CHILD_EXITED_MESSAGE = "Claude CLI subprocess closed before pending tool calls were resolved";
function envFlagEnabled(value) {
  if (value === void 0) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return !["0", "false", "no", "off"].includes(normalized);
}
function isClaudeThinkingDisabled() {
  return envFlagEnabled(process.env.CLAUDE_CODE_DISABLE_THINKING) || envFlagEnabled(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING);
}
function cliEffortLevel(effort) {
  return effort === "minimal" ? "low" : effort;
}
function claudeSpawnEnv(opts) {
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    // Pin the child to the binary whose version we detected, and keep it off
    // non-essential network calls. Fills gaps only, so an explicit shell value
    // survives: see `cliHygieneEnv` for why the version has to hold still.
    ...cliHygieneEnv()
  };
  if (opts?.effort) {
    env.CLAUDE_CODE_EFFORT_LEVEL = cliEffortLevel(opts.effort);
  }
  if (opts?.promptCacheTtl) {
    env.CLAUDE_CODE_PROMPT_CACHE_TTL = opts.promptCacheTtl;
  }
  if (opts?.ignoreAnthropicApiKey) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  if (!isClaudeThinkingDisabled() && process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES === void 0) {
    env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES = "1";
  }
  return env;
}
function touch(key) {
  const existing = activeProcesses.get(key);
  if (existing) {
    activeProcesses.delete(key);
    activeProcesses.set(key, existing);
  }
}
function evictIfNeeded() {
  while (activeProcesses.size >= MAX_ACTIVE_PROCESSES) {
    let victimKey;
    for (const [key, ap] of activeProcesses) {
      if (!isTurnInFlight(ap)) {
        victimKey = key;
        break;
      }
    }
    if (!victimKey) {
      log.warn("every claude process is mid-turn; skipping LRU eviction", {
        active: activeProcesses.size,
        cap: MAX_ACTIVE_PROCESSES
      });
      return;
    }
    log.info("evicting LRU claude process", { sessionKey: victimKey });
    deleteActiveProcess(victimKey);
  }
}
var TURN_INTERRUPT_TIMEOUT_MS = 5e3;
function isTerminalResultLine(line) {
  if (!line.includes('"result"')) return false;
  try {
    return JSON.parse(line).type === "result";
  } catch {
    return false;
  }
}
function settleTurn(ap) {
  ap.turnInFlight = false;
  const waiters = ap.turnIdleWaiters ?? [];
  ap.turnIdleWaiters = [];
  for (const wake of waiters) wake();
}
function noteTurnStarted(ap) {
  if (ap.asideTransport?.interactive) return;
  ap.turnInFlight = true;
}
function noteTurnLine(ap, line) {
  if (!ap.turnInFlight) return;
  if (isTerminalResultLine(line)) settleTurn(ap);
}
function isTurnInFlight(ap) {
  return ap.turnInFlight === true;
}
function awaitTurnIdle(ap, timeoutMs) {
  if (!ap.turnInFlight) return Promise.resolve(true);
  return new Promise((resolve6) => {
    const wake = () => {
      clearTimeout(timer);
      resolve6(true);
    };
    const timer = setTimeout(() => {
      const waiters = ap.turnIdleWaiters ?? [];
      const at = waiters.indexOf(wake);
      if (at >= 0) waiters.splice(at, 1);
      resolve6(false);
    }, timeoutMs);
    (ap.turnIdleWaiters ??= []).push(wake);
  });
}
function interruptTurn(ap, timeoutMs = TURN_INTERRUPT_TIMEOUT_MS) {
  if (!ap.turnInFlight) return Promise.resolve(true);
  const stdin = ap.proc.stdin;
  if (ap.asideTransport?.interactive || !stdin || !stdin.writable) {
    log.notice("cannot interrupt this transport; waiting for the turn to end");
    return awaitTurnIdle(ap, timeoutMs);
  }
  try {
    stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: randomUUID3(),
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
function cancelIdleProcessEviction(key) {
  const timer = idleEvictionTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  idleEvictionTimers.delete(key);
}
function getActiveProcess(key) {
  const ap = activeProcesses.get(key);
  if (ap) {
    cancelIdleProcessEviction(key);
    touch(key);
  }
  return ap;
}
function setActiveProcess(key, ap) {
  cancelIdleProcessEviction(key);
  activeProcesses.set(key, ap);
}
function scheduleIdleProcessEviction(key, timeoutMs) {
  cancelIdleProcessEviction(key);
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_IDLE_TIMEOUT_MS) {
    return;
  }
  const scheduledProcess = activeProcesses.get(key);
  if (!scheduledProcess) return;
  const timer = setTimeout(() => {
    idleEvictionTimers.delete(key);
    if (activeProcesses.get(key) !== scheduledProcess) return;
    if (isTurnInFlight(scheduledProcess)) {
      log.info("idle timer found a turn in flight; re-arming", { sessionKey: key, timeoutMs });
      scheduleIdleProcessEviction(key, timeoutMs);
      return;
    }
    log.info("evicting idle claude process", { sessionKey: key, timeoutMs });
    deleteActiveProcess(key);
  }, timeoutMs);
  timer.unref();
  idleEvictionTimers.set(key, timer);
}
function detachActiveProcess(key) {
  cancelIdleProcessEviction(key);
  const ap = activeProcesses.get(key);
  if (!ap) return void 0;
  activeProcesses.delete(key);
  if (ap.proxyServer) {
    void ap.proxyServer.close();
    rejectAllPendingProxyCallsForSession(key, new Error(SERVER_CLOSED_MESSAGE));
  }
  return ap;
}
function deleteActiveProcessesForSession(sessionID) {
  if (!sessionID || sessionID === "default") return [];
  const released = [];
  for (const [key, ap] of [...activeProcesses]) {
    const owned = ap.opencodeSessionID === sessionID || describeSessionKey(key).session === sessionID;
    if (!owned) continue;
    log.info("releasing claude process for deleted session", { sessionKey: key, sessionID });
    void deleteActiveProcessAndWait(key);
    released.push(key);
  }
  for (const key of [...claudeSessions.keys()]) {
    if (describeSessionKey(key).session !== sessionID) continue;
    deleteClaudeSessionId(key);
    clearCompression(key);
    if (!released.includes(key)) released.push(key);
  }
  return released;
}
function killAllActiveProcesses() {
  const keys = [...activeProcesses.keys()];
  for (const key of keys) deleteActiveProcess(key);
  return keys;
}
var processExitCleanupWired = false;
function ensureProcessExitCleanup() {
  if (processExitCleanupWired) return false;
  processExitCleanupWired = true;
  process.once("exit", () => {
    killAllActiveProcesses();
  });
  return true;
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
  return new Promise((resolve6) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve6(true);
    };
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      resolve6(hasProcessExited(proc));
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
function getClaudeSessionId(key) {
  return claudeSessions.get(key);
}
var MAX_CLAUDE_SESSION_ENTRIES = 64;
function claudeSessionIsBusy(key) {
  if (activeProcesses.has(key)) return true;
  return getPendingProxyCalls(key).length > 0 || hasExitPlanModeQuestions(key);
}
function capClaudeSessions() {
  for (const key of [...claudeSessions.keys()]) {
    if (claudeSessions.size <= MAX_CLAUDE_SESSION_ENTRIES) return;
    if (claudeSessionIsBusy(key)) continue;
    log.info("claude session cap reached; releasing an idle session", {
      sessionKey: key,
      size: claudeSessions.size,
      cap: MAX_CLAUDE_SESSION_ENTRIES
    });
    deleteClaudeSessionId(key);
  }
}
function setClaudeSessionId(key, sessionId) {
  claudeSessions.delete(key);
  claudeSessions.set(key, sessionId);
  capClaudeSessions();
}
function deleteClaudeSessionId(key) {
  clearExitPlanModeQuestions(key);
  clearAccountFailoverQuestions(key);
  const claudeSessionId = claudeSessions.get(key);
  if (claudeSessionId) clearLedger(claudeSessionId);
  claudeSessions.delete(key);
}
function effortSessionKey(baseKey, effort) {
  return effort ? `${baseKey}::effort=${effort}` : baseKey;
}
function invalidateOtherEffortSessions(baseKey, effort) {
  const levels = [
    void 0,
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ];
  const staleKeys = levels.filter((level) => level !== effort).map((level) => effortSessionKey(baseKey, level));
  for (const key of staleKeys) {
    const active = activeProcesses.get(key);
    if (getPendingProxyCalls(key).length || hasExitPlanModeQuestions(key) || active?.pendingProxyCompletions?.size || active && (active.lineEmitter.listenerCount("line") > 0 || isSideQuestionPending(active))) {
      throw new Error(
        "Cannot change reasoning effort while the previous effort session has pending work. Finish that work at its original effort first."
      );
    }
  }
  for (const key of staleKeys) {
    deleteActiveProcess(key);
    deleteClaudeSessionId(key);
    clearCompression(key);
  }
}
function spawnClaudeProcess(cliPath, cliArgs, cwd, sessionKey2, proxyServer, mcpHash, systemPromptFile, ignoreAnthropicApiKey, effort, promptCacheTtl) {
  evictIfNeeded();
  log.info("spawning new claude process", {
    cliPath,
    cliArgs,
    cwd,
    sessionKey: sessionKey2,
    effort,
    promptCacheTtl
  });
  const proc = spawn(cliPath, cliArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: claudeSpawnEnv({ ignoreAnthropicApiKey, effort, promptCacheTtl }),
    shell: process.platform === "win32"
  });
  const lineEmitter = new EventEmitter3();
  const ap = {
    proc,
    lineEmitter,
    proxyServer: proxyServer ?? null,
    mcpHash,
    systemPromptFile,
    effort,
    promptCacheTtl,
    startedAt: Date.now(),
    cliPath,
    cliArgs: [...cliArgs],
    unattendedLines: [],
    unattendedDropped: 0
  };
  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    if (dispatchSideQuestionResponse(ap, line)) return;
    noteTurnLine(ap, line);
    if (lineEmitter.listenerCount("line") === 0) {
      bufferUnattendedLine(ap, line);
      return;
    }
    lineEmitter.emit("line", line);
  });
  rl.on("close", () => {
    settleTurn(ap);
    lineEmitter.emit("close");
  });
  cancelIdleProcessEviction(sessionKey2);
  activeProcesses.set(sessionKey2, ap);
  proc.on("error", (err) => {
    log.error("claude process error", { sessionKey: sessionKey2, error: err.message });
  });
  proc.stdin?.on("error", (err) => {
    log.warn("claude process stdin error", {
      sessionKey: sessionKey2,
      code: err.code,
      error: err.message
    });
    settleTurn(ap);
  });
  proc.on("exit", (code, signal) => {
    log.info("claude process exited", { code, signal, sessionKey: sessionKey2 });
    void proxyServer?.close();
    if (systemPromptFile) {
      void unlink(systemPromptFile).catch(() => {
      });
    }
    const ownsSessionKey = activeProcesses.get(sessionKey2) === ap;
    if (ownsSessionKey) {
      cancelIdleProcessEviction(sessionKey2);
      activeProcesses.delete(sessionKey2);
      if (getPendingProxyCalls(sessionKey2).length > 0) {
        rejectAllPendingProxyCallsForSession(
          sessionKey2,
          new Error(CHILD_EXITED_MESSAGE)
        );
      }
    }
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
    retainStderr(ap, stderr);
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
    appendResumeIfNeeded(sessionKey2, old.cliArgs ?? cliArgs),
    cwd,
    sessionKey2,
    old.proxyServer,
    old.mcpHash,
    old.systemPromptFile,
    ignoreAnthropicApiKey,
    old.effort,
    old.promptCacheTtl
  );
  replacement.pendingProxyCompletions = old.pendingProxyCompletions;
  delete old.pendingProxyCompletions;
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
    disallowedTools,
    appendSystemPromptFile,
    pluginDirs,
    thinking,
    thinkingDisplay,
    fastMode,
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
  const readOnly = isReadOnlyPermissionMode(permissionMode);
  if (readOnly) {
    if (cliSupportsRestricted(cliVersion ?? null)) {
      args.push("--restricted");
    } else {
      log.warn(
        'permissionPreset "read-only": this claude CLI has no --restricted (2.1.258+), so file reads are not confined to the working directory. The mutating tools are still refused via --disallowedTools and every permission request is denied.',
        { cliVersion: cliVersion?.raw ?? "unknown" }
      );
    }
    if (cliSupportsPermissionPrompts(cliVersion ?? null)) {
      args.push("--permission-prompts", "none");
    } else {
      log.warn(
        `permissionPreset "read-only": this claude CLI has no --permission-prompts (2.1.263+), so permission requests are denied by the plugin's own can_use_tool handler instead of by the CLI. Same outcome, one layer fewer.`,
        { cliVersion: cliVersion?.raw ?? "unknown" }
      );
    }
  } else if (permissionMode) {
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
  for (const dir of pluginDirs ?? []) {
    args.push("--plugin-dir", dir);
  }
  if (fastMode && cliSupportsFastMode(cliVersion ?? null)) {
    args.push("--settings", JSON.stringify({ fastMode: true }));
  }
  if (skipPermissions && permissionMode !== "plan" && !readOnly) {
    args.push("--dangerously-skip-permissions");
  }
  return args;
}
function sessionKey(cwd, modelId) {
  return `${cwd}::${modelId}`;
}
function describeSessionKey(key) {
  const parts = key.split("::");
  return {
    cwd: parts[0] ?? "unknown",
    model: parts[1] ?? "unknown",
    session: parts[3] ?? "unknown",
    compaction: parts[2] === "compaction"
  };
}
function snapshotActiveProcesses(now = Date.now()) {
  const out = [];
  for (const [key, ap] of activeProcesses) {
    const described = describeSessionKey(key);
    const lastStderr = ap.lastStderr;
    out.push({
      sessionKey: key,
      session: ap.opencodeSessionID ?? described.session,
      model: described.model,
      compaction: described.compaction,
      pid: ap.proc.pid,
      inFlight: ap.turnInFlight === true,
      ageMs: ap.startedAt === void 0 ? void 0 : Math.max(0, now - ap.startedAt),
      effort: ap.effort,
      attached: ap.lineEmitter.listenerCount("line") > 0,
      proxyUrl: ap.proxyServer?.url,
      lastStderr: typeof lastStderr === "string" ? lastStderr : void 0
    });
  }
  return out;
}

// src/btw-command.ts
var BtwHandledError = class extends Error {
  name = "BtwHandledError";
  constructor(message = "/btw was handled by the claude-code plugin; nothing to add to this conversation.") {
    super(message);
  }
};
var BTW_COMMAND_DESCRIPTION = "Ask a side question in the live Claude Code session without changing its context";
var BTW_NO_SESSION_MESSAGE = "/btw needs a live Claude Code session in this conversation. Send a normal message with a Claude Code model first, then ask again.";
var BTW_INLINE_HANDLED_MESSAGE = "/btw was answered inside the running turn; nothing to add to this conversation.";
var BTW_TURN_TOO_LONG_MESSAGE = "/btw gave up waiting for this turn to end. Ask again once it is over.";
var IDLE_POLL_MS = 500;
var IDLE_WAIT_MAX_MS = 30 * 6e4;
var BUSY_SETTLE_MS = 1500;
var SPAWN_WAIT_MAX_MS = 3e4;
var INLINE_POLL_MS = 200;
var INLINE_WAIT_MAX_MS = 2e4;
var PENDING_ANSWER_TTL_MS = 10 * 6e4;
var PENDING_ANSWER_CAP = 32;
var pendingAnswers = /* @__PURE__ */ new Map();
function rememberSideQuestionAnswer(sessionID, question, answer, now = Date.now()) {
  for (const [id, entry] of pendingAnswers) {
    if (now - entry.at > PENDING_ANSWER_TTL_MS) pendingAnswers.delete(id);
  }
  pendingAnswers.delete(sessionID);
  while (pendingAnswers.size >= PENDING_ANSWER_CAP) {
    const oldest = pendingAnswers.keys().next().value;
    if (oldest === void 0) break;
    pendingAnswers.delete(oldest);
  }
  pendingAnswers.set(sessionID, { question: question.trim(), answer, at: now });
}
function takeSideQuestionAnswer(sessionID, question, now = Date.now()) {
  const entry = pendingAnswers.get(sessionID);
  if (!entry) return void 0;
  pendingAnswers.delete(sessionID);
  if (!question.trim().startsWith(entry.question) || now - entry.at > PENDING_ANSWER_TTL_MS) return void 0;
  return entry.answer;
}
var INLINE_ASIDE_MARKER = "\u258C **btw:**";
var LEGACY_INLINE_ASIDE_MARKERS = ["> **btw:**"];
function barEveryLine(text) {
  return text.split("\n").map((line) => line.trim() === "" ? "\u258C" : `\u258C ${line}`).join("\n");
}
function oneLine(question) {
  return question.replace(/\s+/g, " ").trim();
}
function asideHeader(question) {
  return `${INLINE_ASIDE_MARKER} ${oneLine(question)}`;
}
function formatInlineAside(question, answer) {
  return `
${asideHeader(question)}
\u258C
${barEveryLine(answer.trim())}
`;
}
var INLINE_ASIDE_SENT_NOTE = "*sent to Claude on the side*";
function formatInlineAsideAsk(question) {
  return `
${asideHeader(question)}
\u258C ${INLINE_ASIDE_SENT_NOTE}
`;
}
var asideSinks = /* @__PURE__ */ new Map();
function registerAsideSink(sessionID, sink) {
  asideSinks.set(sessionID, sink);
  return () => {
    if (asideSinks.get(sessionID) === sink) asideSinks.delete(sessionID);
  };
}
function emitAsideInline(sessionID, text) {
  const sink = asideSinks.get(sessionID);
  if (!sink) return false;
  try {
    return sink(text);
  } catch (error) {
    log.debug("btw: could not write the aside into the running turn", { sessionID, error: errorText(error) });
    return false;
  }
}
function showToast(client, body) {
  try {
    void client?.tui?.showToast?.({ body })?.catch((error) => {
      log.debug("btw toast failed", { error: errorText(error) });
    });
  } catch (error) {
    log.debug("btw toast failed", { error: errorText(error) });
  }
}
function isProcessBusy(active) {
  return active.lineEmitter.listenerCount("line") > 0;
}
async function sessionStatus(client, sessionID) {
  const status = client?.session?.status;
  if (!status) return "unknown";
  try {
    const result = await status.call(client.session);
    const entry = result.data?.[sessionID];
    return entry && entry.type !== "idle" ? "busy" : "idle";
  } catch (error) {
    log.debug("btw: could not read session status", { sessionID, error: errorText(error) });
    return "unknown";
  }
}
async function waitForSessionIdle(client, sessionID, options = {}) {
  const pollMs = options.pollMs ?? IDLE_POLL_MS;
  const timeoutMs = options.timeoutMs ?? IDLE_WAIT_MAX_MS;
  const started = Date.now();
  for (; ; ) {
    if (options.stop?.()) return true;
    if (await sessionStatus(client, sessionID) !== "busy") return true;
    if (Date.now() - started >= timeoutMs) return false;
    await new Promise((resolve6) => setTimeout(resolve6, pollMs));
  }
}
async function deliverAsideInline(client, sessionID, text, options = {}) {
  const pollMs = options.inlinePollMs ?? INLINE_POLL_MS;
  const timeoutMs = options.inlineWaitMs ?? INLINE_WAIT_MAX_MS;
  const started = Date.now();
  for (; ; ) {
    if (emitAsideInline(sessionID, text)) return true;
    if (Date.now() - started >= timeoutMs) return false;
    if (await sessionStatus(client, sessionID) !== "busy") return false;
    await new Promise((resolve6) => setTimeout(resolve6, pollMs));
  }
}
async function waitForAsideProcess(client, sessionID, options = {}) {
  const pollMs = options.pollMs ?? IDLE_POLL_MS;
  const settleMs = options.settleMs ?? BUSY_SETTLE_MS;
  const spawnWaitMs = options.spawnWaitMs ?? SPAWN_WAIT_MAX_MS;
  const started = Date.now();
  for (; ; ) {
    const active = findActiveProcessBySessionId(sessionID);
    if (active) return active;
    const busy = await sessionStatus(client, sessionID) === "busy";
    const waitedMs = Date.now() - started;
    if (!busy && waitedMs >= settleMs) {
      log.info("btw: no live claude process for session, leaving it to the turn", { sessionID, waitedMs });
      return void 0;
    }
    if (busy && waitedMs >= spawnWaitMs) {
      log.warn("btw: a turn is running but no claude process appeared for it", { sessionID, waitedMs });
      return void 0;
    }
    await new Promise((resolve6) => setTimeout(resolve6, pollMs));
  }
}
async function settleSessionBusy(client, sessionID, active, options = {}) {
  const pollMs = options.pollMs ?? IDLE_POLL_MS;
  const settleMs = options.settleMs ?? BUSY_SETTLE_MS;
  const started = Date.now();
  for (; ; ) {
    const status = await sessionStatus(client, sessionID);
    if (status === "busy") return true;
    if (status === "unknown") return isProcessBusy(active);
    if (Date.now() - started >= settleMs) return false;
    await new Promise((resolve6) => setTimeout(resolve6, pollMs));
  }
}
function errorText(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}
function isTextPart(part) {
  return part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string";
}
async function fetchAsideHistory(client, sessionID, question) {
  const messages = client?.session?.messages;
  if (!messages) return [];
  try {
    const result = await messages.call(client.session, { path: { id: sessionID } });
    const prompt = [];
    for (const message of result.data ?? []) {
      const role = message.info?.role;
      if (role !== "user" && role !== "assistant") continue;
      prompt.push({ role, content: (message.parts ?? []).filter(isTextPart) });
    }
    prompt.push({ role: "user", content: `/btw ${question}` });
    return collectSideQuestionHistory(prompt);
  } catch (error) {
    log.debug("btw: could not read aside history", { sessionID, error: errorText(error) });
    return [];
  }
}
async function handleBtwCommand(client, input, options = {}) {
  const question = input.arguments.trim();
  if (!question) {
    showToast(client, { title: "btw", message: SIDE_QUESTION_USAGE, variant: "warning", duration: 6e3 });
    throw new BtwHandledError("/btw needs a question.");
  }
  const active = await waitForAsideProcess(client, input.sessionID, options);
  const transport = active?.asideTransport;
  if (!active || !transport) {
    if (active) log.info("btw: process has no aside transport, leaving it to the turn", { sessionID: input.sessionID });
    return;
  }
  let busy = false;
  let inlineDone = false;
  let markInlineDelivered = () => {
  };
  const inlineDelivered = new Promise((resolve6) => {
    markInlineDelivered = () => {
      inlineDone = true;
      resolve6("inline");
    };
  });
  if (isSideQuestionPending(active)) {
    busy = await settleSessionBusy(client, input.sessionID, active, options);
    log.info("btw: an aside is already in flight, leaving this one to the turn", { sessionID: input.sessionID, busy });
  } else {
    const settling = settleSessionBusy(client, input.sessionID, active, options);
    const history = await fetchAsideHistory(client, input.sessionID, question);
    const answer = requestSideQuestion(active, question, {
      cliVersion: await detectCliVersion(transport.cliPath),
      interactive: transport.interactive,
      ...history.length ? { history } : {}
    });
    answer.catch(() => void 0);
    rememberSideQuestionAnswer(input.sessionID, question, answer);
    busy = await settling;
    log.info("btw: aside sent ahead of its message", {
      sessionID: input.sessionID,
      busy,
      questionLength: question.length,
      history: history.length
    });
    const asked = busy ? deliverAsideInline(client, input.sessionID, formatInlineAsideAsk(question), options).catch(() => false) : Promise.resolve(false);
    answer.then(
      async (result) => {
        log.info("btw: early answer arrived", { sessionID: input.sessionID, busy, responseLength: result.response.length });
        if (!busy || result.synthetic) return;
        await asked;
        const inline = await deliverAsideInline(
          client,
          input.sessionID,
          formatInlineAside(question, result.response),
          options
        );
        if (inline) {
          log.info("btw: answer written into the running turn", { sessionID: input.sessionID });
          markInlineDelivered();
          return;
        }
        log.info("btw: no open stream for the answer; the held message will carry it", {
          sessionID: input.sessionID
        });
      },
      (error) => {
        log.warn("btw: early aside failed; the message will ask again", {
          sessionID: input.sessionID,
          error: errorText(error)
        });
      }
    );
  }
  if (!busy) return;
  const started = Date.now();
  const outcome = await Promise.race([
    inlineDelivered,
    waitForSessionIdle(client, input.sessionID, { ...options, stop: () => inlineDone }).then(
      (idle) => idle ? "idle" : "timeout"
    )
  ]);
  if (outcome === "inline") {
    log.info("btw: answered inside the running turn, dropping the /btw message", {
      sessionID: input.sessionID,
      waitedMs: Date.now() - started
    });
    throw new BtwHandledError(BTW_INLINE_HANDLED_MESSAGE);
  }
  log.info("btw: turn over, releasing the /btw message", {
    sessionID: input.sessionID,
    idle: outcome === "idle",
    waitedMs: Date.now() - started
  });
  if (outcome === "timeout") {
    showToast(client, { title: "btw", message: BTW_TURN_TOO_LONG_MESSAGE, variant: "warning", duration: 8e3 });
    throw new BtwHandledError(BTW_TURN_TOO_LONG_MESSAGE);
  }
}

// src/plan-usage.ts
import { execFile as execFile2 } from "child_process";
var PLAN_USAGE_ARGUMENTS = /* @__PURE__ */ new Set(["usage", "cost", "stats", "limits"]);
function wantsPlanUsage(argument) {
  return PLAN_USAGE_ARGUMENTS.has(argument.trim().toLowerCase());
}
var PLAN_USAGE_MAX_CHARS = 4e3;
function truncate(text) {
  return text.length <= PLAN_USAGE_MAX_CHARS ? text : `${text.slice(0, PLAN_USAGE_MAX_CHARS)}
[truncated]`;
}
function parsePlanUsage(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return { status: "failed", error: "the CLI printed nothing" };
  const candidates = trimmed.split("\n").reverse();
  for (const line of candidates) {
    const start = line.indexOf("{");
    if (start === -1) continue;
    let parsed;
    try {
      parsed = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed;
    if (record.type !== void 0 && record.type !== "result") continue;
    const text = typeof record.result === "string" ? record.result.trim() : "";
    if (record.is_error === true) {
      return { status: "failed", error: text || "the CLI reported an error" };
    }
    if (!text) continue;
    return {
      status: "ok",
      text: truncate(text),
      costUsd: typeof record.total_cost_usd === "number" ? record.total_cost_usd : 0,
      numTurns: typeof record.num_turns === "number" ? record.num_turns : 0
    };
  }
  return { status: "failed", error: "no result object in the CLI's reply" };
}
function runCli(cliPath, args, timeoutMs, env) {
  return new Promise((resolve6, reject) => {
    execFile2(
      cliPath,
      args,
      // `killSignal` so a CLI wedged on a hook is actually gone, and a generous
      // buffer because the reply is prose of unbounded length.
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, env },
      (error, stdout) => {
        if (stdout && stdout.trim()) return resolve6(stdout);
        if (error) return reject(error);
        resolve6(stdout ?? "");
      }
    );
  });
}
async function fetchPlanUsage(cliPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2e4;
  const run = options.runImpl ?? runCli;
  try {
    const env = claudeSpawnEnv({ ignoreAnthropicApiKey: options.ignoreAnthropicApiKey });
    const stdout = await run(
      cliPath,
      ["-p", "/cost", "--output-format", "json"],
      timeoutMs,
      env
    );
    const usage = parsePlanUsage(stdout);
    if (usage.status === "ok") {
      log.info("read claude plan usage", { costUsd: usage.costUsd, numTurns: usage.numTurns });
    } else if (usage.status === "failed") {
      log.debug("could not read claude plan usage", { error: usage.error });
    }
    return usage;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.debug("could not read claude plan usage", { error: message });
    return { status: "failed", error: message };
  }
}

// src/startup-diagnostics.ts
import { execFile as execFile3 } from "child_process";
import * as fs4 from "fs";
import * as path5 from "path";
import { promisify as promisify2 } from "util";
import { fileURLToPath } from "url";

// src/mcp-bridge.ts
import * as fs3 from "fs";
import * as path4 from "path";
import * as os2 from "os";
import * as crypto2 from "crypto";
import {
  parse as parseJsonc,
  printParseErrorCode
} from "jsonc-parser";
var FILE_NAMES = ["opencode.jsonc", "opencode.json", "config.json"];
var PROJECT_FILE_NAMES = ["opencode.json", "opencode.jsonc"];
function fileExists(p) {
  try {
    return fs3.statSync(p).isFile();
  } catch {
    return false;
  }
}
function dirExists(p) {
  try {
    return fs3.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function readAndParse(file) {
  try {
    const raw = fs3.readFileSync(file, "utf8");
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
  let current = path4.resolve(opts.start);
  while (true) {
    for (const target of opts.targets) {
      const candidate = path4.join(current, target);
      if (opts.predicate(candidate)) out.push(candidate);
    }
    if (opts.stop && current === path4.resolve(opts.stop)) break;
    const parent = path4.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}
function detectWorktree(cwd) {
  const override = process.env.OPENCODE_WORKTREE;
  if (override) return path4.resolve(override);
  let current = path4.resolve(cwd);
  while (true) {
    const gitPath = path4.join(current, ".git");
    try {
      if (fs3.existsSync(gitPath)) return current;
    } catch {
    }
    const parent = path4.dirname(current);
    if (parent === current) return void 0;
    current = parent;
  }
}
function globalConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME ?? path4.join(os2.homedir(), ".config");
  return path4.join(xdg, "opencode");
}
function loadGlobalConfig() {
  const dir = globalConfigDir();
  let merged = {};
  for (const name of FILE_NAMES.slice().reverse()) {
    const file = path4.join(dir, name);
    if (!fileExists(file)) continue;
    const parsed = readAndParse(file);
    if (parsed) merged = deepMerge(merged, parsed);
  }
  return merged;
}
function loadProjectFilesInDir(dir) {
  let merged = {};
  for (const name of PROJECT_FILE_NAMES) {
    const file = path4.join(dir, name);
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
    const abs = path4.resolve(p);
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
    const homeDot = path4.join(home, ".opencode");
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
function opencodeConfigLayers(cwd) {
  const worktree = detectWorktree(cwd);
  const layers = [];
  layers.push(loadGlobalConfig());
  const explicitConfig = process.env.OPENCODE_CONFIG;
  if (explicitConfig && fileExists(explicitConfig)) {
    const parsed = readAndParse(explicitConfig);
    if (parsed) layers.push(parsed);
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
    const d = path4.dirname(f);
    if (!seenProjectDirs.has(d)) {
      seenProjectDirs.add(d);
      projectDirs.push(d);
    }
  }
  for (const dir of projectDirs.slice().reverse()) {
    layers.push(loadProjectFilesInDir(dir));
  }
  for (const dir of dotOpencodeDirs(cwd, worktree)) {
    layers.push(loadProjectFilesInDir(dir));
  }
  return layers;
}
function loadMergedOpencodeConfig(cwd) {
  let merged = {};
  for (const layer of opencodeConfigLayers(cwd)) merged = deepMerge(merged, layer);
  return merged;
}
function mergeOpencodeMcp(cwd, runtimeStatus) {
  let merged = {};
  for (const layer of opencodeConfigLayers(cwd)) {
    merged = mergeMcp(merged, extractMcpBlock(layer));
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
  const hash = crypto2.createHash("sha256").update(mergedBody).digest("hex").slice(0, 12);
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
  const bodyDigest = crypto2.createHash("sha256").update(body).digest("hex").slice(0, 12);
  const outPath = path4.join(
    pluginTmpDir(),
    `mcp-${bodyDigest}.json`
  );
  try {
    if (!fileExists(outPath)) {
      fs3.writeFileSync(outPath, body, { encoding: "utf8", mode: 384 });
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

// src/runtime-status.ts
var opencodeClient = null;
function setOpencodeClient(client) {
  if (client && typeof client === "object") {
    opencodeClient = client;
  }
}
function getOpencodeClient() {
  return opencodeClient;
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
function resolveSpawnCwdFrom(configured, live, captured, sessionDir) {
  if (configured) return configured;
  if (isUsableDirectory(sessionDir)) return sessionDir;
  if (isUsableDirectory(live)) return live;
  return captured ?? live;
}
async function resolveSpawnCwdForSession(configured, sessionID) {
  if (configured) return configured;
  const sessionDir = sessionID ? await fetchSessionDirectory(sessionID) : void 0;
  return resolveSpawnCwdFrom(
    configured,
    process.cwd(),
    opencodeProjectDirectory,
    sessionDir
  );
}
async function fetchSessionDirectory(sessionID) {
  if (!sessionID || sessionID === "default") return void 0;
  const client = opencodeClient;
  if (!client?.session?.get) return void 0;
  try {
    const res = await client.session.get({ path: { id: sessionID } });
    const data = res.data;
    if (!data || typeof data !== "object") return void 0;
    const dir = data.directory;
    return isUsableDirectory(dir) ? dir : void 0;
  } catch (err) {
    log.warn("failed to fetch opencode session directory", {
      sessionID,
      error: err instanceof Error ? err.message : String(err)
    });
    return void 0;
  }
}
async function fetchSessionParentId(sessionID) {
  if (!sessionID || sessionID === "default") return void 0;
  const client = opencodeClient;
  if (!client?.session?.get) return void 0;
  try {
    const res = await client.session.get({ path: { id: sessionID } });
    const data = res.data;
    if (!data || typeof data !== "object") return void 0;
    const parentID = data.parentID;
    return typeof parentID === "string" && parentID.length > 0 ? parentID : void 0;
  } catch (err) {
    log.warn("failed to fetch opencode session parent", {
      sessionID,
      error: err instanceof Error ? err.message : String(err)
    });
    return void 0;
  }
}
async function fetchSessionRunState(sessionID) {
  if (!sessionID || sessionID === "default") return "unknown";
  const status = opencodeClient?.session?.status;
  if (!status) return "unknown";
  try {
    const res = await status.call(opencodeClient.session);
    const data = res.data;
    if (!data || typeof data !== "object") return "unknown";
    const entry = data[sessionID];
    if (!entry || typeof entry !== "object") return "idle";
    const type = entry.type;
    return type === "idle" ? "idle" : "busy";
  } catch (err) {
    log.debug("failed to read opencode session status", {
      sessionID,
      error: err instanceof Error ? err.message : String(err)
    });
    return "unknown";
  }
}
async function settleSessionRunState(sessionID, options = {}) {
  const pollMs = options.pollMs ?? 150;
  const windowMs = options.windowMs ?? 1500;
  const started = Date.now();
  let last = "unknown";
  for (; ; ) {
    const state = await fetchSessionRunState(sessionID);
    if (state === "busy") return "busy";
    if (state !== "unknown") last = state;
    if (Date.now() - started >= windowMs) return last;
    await new Promise((resolve6) => setTimeout(resolve6, pollMs));
  }
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

// src/startup-diagnostics.ts
var cachedPluginVersion;
function pluginVersion() {
  if (cachedPluginVersion) return cachedPluginVersion;
  try {
    const here = path5.dirname(fileURLToPath(import.meta.url));
    const raw = fs4.readFileSync(path5.join(here, "..", "package.json"), "utf8");
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
var execFileAsync2 = promisify2(execFile3);
var opencodeVersionProbe;
function detectOpencodeVersion(execPath = process.execPath) {
  if (opencodeVersionProbe) return opencodeVersionProbe;
  opencodeVersionProbe = (async () => {
    if (!path5.basename(execPath).toLowerCase().includes("opencode")) {
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
    permissionPresets: Object.entries(providers).map(
      ([name, entry]) => summarizePermissionPreset(name, entry?.options)
    ),
    interactiveTransport: firstOption(providers, "interactive") === true || process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT === "1",
    planModeQuestion: firstOption(providers, "planModeQuestion") === true,
    anthropicApiKeyInEnv: Boolean(
      process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
    )
  };
}
var logged = false;
var lastProviders = {};
var lastOpencodeVersion;
function lastDiagnosticsProviders() {
  return lastProviders;
}
function lastKnownOpencodeVersion() {
  return lastOpencodeVersion;
}
function logStartupDiagnostics(providers, opencodeVersion) {
  lastProviders = providers;
  if (opencodeVersion) lastOpencodeVersion = opencodeVersion;
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

// src/doctor.ts
var DOCTOR_COMMAND = "claude-code-doctor";
var DOCTOR_COMMAND_DESCRIPTION = "Report what the Claude Code plugin sees: versions, cwd, live processes, pending proxy calls. Add `usage` for plan windows";
var DOCTOR_MARKER = "\u258C **claude-code doctor**";
function isRecord3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
var SYSTEM_REMINDER_BLOCK2 = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
function parseDoctorCommandContent(content) {
  let text;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (!isRecord3(part) || part.type !== "text" || typeof part.text !== "string") return null;
      parts.push(part.text);
    }
    text = parts.join("\n");
  } else {
    return null;
  }
  const match = new RegExp(`^/${DOCTOR_COMMAND}(?:\\s+([\\s\\S]*))?$`).exec(
    text.replace(SYSTEM_REMINDER_BLOCK2, "").trim()
  );
  return match ? { rest: (match[1] ?? "").trim() } : null;
}
function parseDoctorCommand(prompt) {
  const latest = prompt.at(-1);
  return latest?.role === "user" ? parseDoctorCommandContent(latest.content) : null;
}
function formatAge(ms) {
  if (ms === void 0) return "unknown";
  if (ms < 1e3) return `${Math.round(ms)}ms`;
  if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
  const minutes = Math.floor(ms / 6e4);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function list(values) {
  return values.length ? values.join(", ") : "none";
}
function describeAuth(auth) {
  switch (auth.status) {
    case "ok":
      return `${auth.code}, good`;
    case "unsafe":
      return `${auth.code}, UNSAFE: an unauthenticated caller was accepted. Restart every opencode window; a window opened before 0.13.2 keeps serving an open port.`;
    case "unreachable":
      return `could not be checked (${auth.error})`;
    case "skipped":
      return "not checked";
  }
}
function describePermissionPresets(rows) {
  if (rows.length === 0) return NO_PERMISSION_PRESET;
  return rows.map((row) => {
    const suffix = row.preset === NO_PERMISSION_PRESET || row.applied ? "" : " (unknown, nothing applied)";
    return `${row.provider}: ${row.preset}${suffix}`;
  }).join(", ");
}
function formatDoctorReport(report) {
  const lines = [];
  lines.push(DOCTOR_MARKER);
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| plugin | ${report.plugin} |`);
  lines.push(`| opencode | ${report.opencode} |`);
  lines.push(`| claude CLI | \`${report.claudeCli.path}\` (${report.claudeCli.version}) |`);
  lines.push(`| cwd | \`${report.cwd.resolved}\` (${report.cwd.source}) |`);
  lines.push(`| providers | ${list(report.providers)} |`);
  lines.push(`| accounts | ${list(report.accounts)} |`);
  lines.push(`| proxyTools | ${list(report.proxyTools)} |`);
  lines.push(`| MCP servers (on disk) | ${list(report.mcpServers)} |`);
  lines.push(`| permissionPreset | ${describePermissionPresets(report.permissionPresets)} |`);
  lines.push(`| transport | ${report.transport} |`);
  lines.push(`| planModeQuestion | ${report.planModeQuestion} |`);
  lines.push(`| turnStats | ${report.turnStats} |`);
  lines.push(`| ANTHROPIC_API_KEY in env | ${report.anthropicApiKeyInEnv ? "yes" : "no"} |`);
  const overriding = report.permissionPresets.filter((row) => row.overrides.length > 0);
  if (overriding.length > 0) {
    lines.push("");
    lines.push("**Permission preset overrides**");
    for (const row of overriding) {
      lines.push("");
      lines.push(`\`${row.provider}\` (${row.preset}) replaced:`);
      lines.push("");
      for (const override of row.overrides) lines.push(`- ${override}`);
    }
  }
  lines.push("");
  lines.push("**Live `claude` processes**");
  lines.push("");
  if (report.processes.length === 0) {
    lines.push("None. The next message in a Claude Code session spawns one.");
  } else {
    lines.push("| session | model | pid | in flight | age | effort |");
    lines.push("|---|---|---|---|---|---|");
    for (const proc of report.processes) {
      lines.push(
        `| ${proc.session}${proc.compaction ? " (compaction)" : ""} | ${proc.model} | ${proc.pid ?? "unknown"} | ${proc.inFlight ? "yes" : "no"} | ${formatAge(proc.ageMs)} | ${proc.effort ?? "inherited"} |`
      );
    }
  }
  lines.push("");
  lines.push("**Pending proxy calls**");
  lines.push("");
  if (report.pendingCalls.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| tool | call id | age | deadline |");
    lines.push("|---|---|---|---|");
    for (const call of report.pendingCalls) {
      const deadline = call.deadlineMs > 0 ? formatAge(call.deadlineMs) : "none";
      lines.push(
        `| ${call.toolName} | \`${call.toolCallId}\` | ${formatAge(call.ageMs)} | ${deadline} |`
      );
    }
  }
  lines.push("");
  lines.push("**Proxy servers**");
  lines.push("");
  if (report.proxyServers.length === 0) {
    lines.push("None running.");
  } else {
    lines.push("| url | unauthenticated `initialize` |");
    lines.push("|---|---|");
    for (const server2 of report.proxyServers) {
      lines.push(`| ${server2.url} | ${describeAuth(server2.auth)} |`);
    }
  }
  if (report.mcpServerErrors.length > 0) {
    lines.push("");
    lines.push("**MCP config entries Claude Code skipped**");
    lines.push("");
    lines.push("| server | category | Claude Code said |");
    lines.push("|---|---|---|");
    for (const error of report.mcpServerErrors) {
      lines.push(`| ${error.name} | \`${error.type}\` | ${error.message || "no detail"} |`);
    }
    lines.push("");
    lines.push("A skipped server is missing from the model's tools with no other sign of it.");
  }
  lines.push("");
  lines.push("**Plan usage**");
  lines.push("");
  switch (report.planUsage.status) {
    case "ok":
      lines.push("```text");
      lines.push(report.planUsage.text);
      lines.push("```");
      break;
    case "failed":
      lines.push(`Could not read it from the CLI: ${report.planUsage.error}`);
      break;
    case "not-requested":
      lines.push(
        "Not checked. Run `/claude-code-doctor usage` for the account's plan windows and reset times, straight from the CLI. It costs no tokens, but it does start a `claude` process, so it runs your `SessionStart` hooks and takes a few seconds."
      );
      break;
  }
  const stderr = report.processes.filter((proc) => proc.lastStderr);
  if (stderr.length > 0) {
    lines.push("");
    lines.push("**Last stderr**");
    lines.push("");
    for (const proc of stderr) {
      lines.push(`\`${proc.session}\`:`);
      lines.push("");
      lines.push("```text");
      lines.push(proc.lastStderr.trimEnd());
      lines.push("```");
    }
  }
  return lines.join("\n");
}
async function checkProxyAuth(url, fetchImpl = fetch, timeoutMs = 3e3) {
  let authority;
  try {
    authority = new URL(url).host;
  } catch {
    return { status: "skipped" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", host: authority },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
      signal: controller.signal
    });
    await response.text().catch(() => "");
    return response.status === 401 ? { status: "ok", code: response.status } : { status: "unsafe", code: response.status };
  } catch (error) {
    return {
      status: "unreachable",
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}
async function gatherDoctorReport(options) {
  const providers = lastDiagnosticsProviders();
  const opencodeVersion = lastKnownOpencodeVersion() ?? process.env.OPENCODE_VERSION ?? await detectOpencodeVersion().catch(() => void 0);
  const { claudeCliPath, ...base } = collectStartupDiagnostics(providers, opencodeVersion);
  const cliPath = options.cliPath || claudeCliPath;
  const cli = await detectCliVersion(cliPath).catch(() => null);
  const processes = snapshotActiveProcesses();
  const seen = /* @__PURE__ */ new Set();
  const proxyServers = [];
  for (const proc of processes) {
    if (!proc.proxyUrl || seen.has(proc.proxyUrl)) continue;
    seen.add(proc.proxyUrl);
    proxyServers.push({
      url: proc.proxyUrl,
      auth: await checkProxyAuth(proc.proxyUrl, options.fetchImpl ?? fetch)
    });
  }
  const planUsage = wantsPlanUsage(options.argument ?? "") ? await (options.planUsageImpl ?? fetchPlanUsage)(cliPath, {
    ignoreAnthropicApiKey: options.ignoreAnthropicApiKey
  }) : { status: "not-requested" };
  return {
    plugin: base.plugin,
    opencode: base.opencode,
    claudeCli: { path: cliPath, version: cli?.raw ?? "not detected" },
    cwd: base.cwd,
    providers: base.providers,
    accounts: base.accounts,
    proxyTools: base.proxyTools,
    mcpServers: base.mcpServers,
    permissionPresets: base.permissionPresets,
    transport: options.interactive || base.interactiveTransport ? "interactive" : "headless",
    planModeQuestion: base.planModeQuestion,
    turnStats: options.turnStats,
    anthropicApiKeyInEnv: base.anthropicApiKeyInEnv,
    processes,
    pendingCalls: snapshotPendingProxyCalls(),
    proxyServers,
    mcpServerErrors: snapshotMcpServerErrors(),
    planUsage
  };
}
async function buildDoctorReport(options) {
  try {
    const report = await gatherDoctorReport(options);
    log.info("claude-code doctor report", {
      plugin: report.plugin,
      opencode: report.opencode,
      cwd: report.cwd,
      processes: report.processes.length,
      pendingCalls: report.pendingCalls.length,
      proxyServers: report.proxyServers.map((server2) => server2.auth.status),
      mcpServerErrors: report.mcpServerErrors.length,
      planUsage: report.planUsage.status
    });
    return formatDoctorReport(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("claude-code doctor failed to build its report", { error: message });
    return `${DOCTOR_MARKER}

Could not build the report: ${message}`;
  }
}

// src/agent-models.ts
import { readFile, readdir } from "fs/promises";
import path6 from "path";

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
function passthroughModel(id) {
  return {
    id,
    providerID: PROVIDER_ID,
    api: { id, url: "", npm: NPM },
    name: id,
    family: "",
    capabilities: { ...baseCapabilities, reasoning: true },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 2e5, output: 64e3 },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
    variants: reasoningVariants
  };
}
var haikuCost = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
var sonnetCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
var opusCost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
var fableCost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
var fable51Cost = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 };
var opusFastCost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
var opus55Cost = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
var opus55FastCost = { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 };
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
  // Fast mode. The `-fast` suffix is OUR marker, not a model name Anthropic
  // serves: `parseModelId` strips it before `--model` and turns it into
  // `--settings {"fastMode":true}` on the spawn. Retired `-fast` model strings
  // (`claude-opus-4-6-fast`) are a different thing and are not registered here.
  //
  // Only Opus 4.8, Opus 5 and Opus 5.5 qualify: the CLI gates fast mode on
  // the resolved model name containing `opus-4-8` or `opus-5` (which
  // `claude-opus-5-5` satisfies too, and 2.1.280's model catalog lists
  // `fast_mode` for it outright), so registering a fast entry for any other
  // model would produce a picker option that silently runs at standard speed
  // while displaying the fast price.
  "claude-opus-4-8-fast": defineModel({
    id: "claude-opus-4-8-fast",
    name: "Claude Opus 4.8 Fast",
    family: "opus",
    reasoning: true,
    context: 1e6,
    output: 128e3,
    cost: opusFastCost,
    multiplier: 10,
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
  "claude-opus-5-fast": defineModel({
    id: "claude-opus-5-fast",
    name: "Claude Opus 5 Fast",
    family: "opus",
    reasoning: true,
    context: 1e6,
    output: 128e3,
    cost: opusFastCost,
    multiplier: 10,
    releaseDate: "2026-07-24"
  }),
  // Opus 5.5 needs Claude Code 2.1.280+: the API rejects it from an older CLI
  // with a 400 naming that floor, which the plugin surfaces as a turn error.
  // Thinking cannot be switched off for it (the CLI's catalog marks it
  // `rejects_disabled_thinking`); the plugin never asks for that, so nothing
  // here has to special-case it.
  "claude-opus-5-5": defineModel({
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    family: "opus",
    reasoning: true,
    context: 1e6,
    output: 128e3,
    cost: opus55Cost,
    multiplier: 4,
    releaseDate: "2026-09-22"
  }),
  "claude-opus-5-5-fast": defineModel({
    id: "claude-opus-5-5-fast",
    name: "Claude Opus 5.5 Fast",
    family: "opus",
    reasoning: true,
    context: 1e6,
    output: 128e3,
    cost: opus55FastCost,
    multiplier: 8,
    releaseDate: "2026-09-22"
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
  // Mythos 5 and 5.1 share the corresponding Fable models' capabilities and
  // pricing without the safety classifiers; limited availability via Project
  // Glasswing. `claude --model` simply errors for accounts without access, so
  // they are safe to register unconditionally.
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
  }),
  "claude-mythos-5-1": defineModel({
    id: "claude-mythos-5-1",
    name: "Claude Mythos 5.1",
    family: "mythos",
    reasoning: true,
    context: 1e6,
    output: 128e3,
    cost: fable51Cost,
    multiplier: 10,
    releaseDate: "2026-09-01"
  })
};
var FAST_SUFFIX = "-fast";
function parseModelId(modelId) {
  const at = modelId.indexOf("@");
  const base = at === -1 ? modelId : modelId.slice(0, at);
  const account = at === -1 ? "" : modelId.slice(at);
  if (!base.endsWith(FAST_SUFFIX)) return { model: modelId, fast: false };
  if (!Object.hasOwn(defaultModels, base)) return { model: modelId, fast: false };
  return { model: base.slice(0, -FAST_SUFFIX.length) + account, fast: true };
}

// src/agent-models.ts
var AGENT_DIR_NAMES = ["agents", "agent"];
var PROMPT_CACHE_TTLS = ["5m", "1h"];
var REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];
var registry = {};
var defaultSubagentModel;
var defaultSubagentCacheTtl;
var providerFallbackModels = [];
function setAgentRegistry(records) {
  registry = records;
}
function getAgentRegistry() {
  return registry;
}
function setDefaultSubagentModel(model) {
  defaultSubagentModel = model?.trim() || void 0;
}
function getDefaultSubagentModel() {
  return defaultSubagentModel;
}
function setDefaultSubagentCacheTtl(ttl) {
  defaultSubagentCacheTtl = ttl?.trim() || void 0;
}
function setProviderFallbackModels(models) {
  providerFallbackModels = models ?? [];
}
function getProviderFallbackModels() {
  return providerFallbackModels;
}
function accountMarker(modelId) {
  const at = modelId.indexOf("@");
  return at === -1 ? "" : modelId.slice(at);
}
function withoutAccountMarker(modelId) {
  const at = modelId.indexOf("@");
  return at === -1 ? modelId : modelId.slice(0, at);
}
function qualifyModelName(wanted, referenceModelId) {
  const base = withoutAccountMarker(wanted.trim());
  if (!base || !Object.hasOwn(defaultModels, base)) return null;
  return `${base}${accountMarker(referenceModelId)}`;
}
function resolveAgentModel(agent, modelId, overrides) {
  if (!agent) return modelId;
  const record = (overrides?.records ?? registry)[agent];
  if (!record) return modelId;
  if (record.model?.includes("/")) return modelId;
  const fallback = overrides ? overrides.defaultSubagentModel : defaultSubagentModel;
  const declared = record.forceModel?.trim();
  const wanted = declared || (record.mode === "subagent" ? fallback : void 0);
  if (!wanted) return modelId;
  const resolved = qualifyModelName(wanted, modelId);
  if (!resolved) {
    log.warn("agent model override refused: unknown model", {
      agent,
      wanted: withoutAccountMarker(wanted),
      keeping: modelId
    });
    return modelId;
  }
  if (resolved !== modelId) {
    log.debug("agent model override", { agent, from: modelId, to: resolved });
  }
  return resolved;
}
function resolveAgentEffort(agent, inherited, overrides) {
  if (!agent) return inherited;
  const record = (overrides?.records ?? registry)[agent];
  const declared = record?.reasoningEffort?.trim();
  if (!declared) return inherited;
  if (!REASONING_EFFORTS.includes(declared)) {
    log.warn("agent effort override refused: unknown level", {
      agent,
      wanted: declared,
      keeping: inherited
    });
    return inherited;
  }
  if (declared !== inherited) {
    log.debug("agent effort override", {
      agent,
      from: inherited,
      to: declared
    });
  }
  return declared;
}
function resolveAgentCacheTtl(agent, overrides) {
  if (!agent) return void 0;
  const record = (overrides?.records ?? registry)[agent];
  if (!record) return void 0;
  const fallback = overrides ? overrides.defaultSubagentCacheTtl : defaultSubagentCacheTtl;
  const declared = record.cacheTtl?.trim();
  const wanted = declared || (record.mode === "subagent" ? fallback?.trim() : void 0);
  if (!wanted) return void 0;
  if (!PROMPT_CACHE_TTLS.includes(wanted)) {
    log.warn("agent prompt cache ttl refused: unknown value", {
      agent,
      wanted,
      allowed: PROMPT_CACHE_TTLS.join(", ")
    });
    return void 0;
  }
  log.debug("agent prompt cache ttl", { agent, ttl: wanted });
  return wanted;
}
function parseAgentFrontmatter(text) {
  const record = {};
  if (!text.startsWith("---")) return record;
  const lines = text.split(/\r?\n/);
  let listKey = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    if (listKey) {
      const item = /^[ \t]*-[ \t]+(.*)$/.exec(line);
      if (item) {
        const value2 = item[1].trim().replace(/^["']|["']$/g, "");
        if (value2) (record[listKey] ??= []).push(value2);
        continue;
      }
      listKey = null;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (key === "fallbackModels") {
      if (value) record.fallbackModels = parseFallbackModelList(value);
      else listKey = "fallbackModels";
      continue;
    }
    if (!value) continue;
    if (key === "mode") record.mode = value;
    else if (key === "model") record.model = value;
    else if (key === "forceModel") record.forceModel = value;
    else if (key === "reasoningEffort") record.reasoningEffort = value;
    else if (key === "cacheTtl") record.cacheTtl = value;
  }
  return record;
}
function parseFallbackModelList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
  }
  if (typeof value !== "string") return [];
  return value.trim().replace(/^\[|\]$/g, "").split(/[,\s]+/).map((entry) => entry.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}
async function readAgentMarkdownRecords(directories) {
  const records = {};
  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const name = entry.slice(0, -3);
      if (records[name]) continue;
      try {
        const text = await readFile(path6.join(directory, entry), "utf8");
        records[name] = parseAgentFrontmatter(text);
      } catch (err) {
        log.debug("failed to read agent markdown", {
          file: path6.join(directory, entry),
          error: String(err)
        });
      }
    }
  }
  return records;
}
function agentDirectories(home, projectDirectory) {
  const directories = [];
  if (projectDirectory) {
    for (const name of AGENT_DIR_NAMES) {
      directories.push(path6.join(projectDirectory, ".opencode", name));
    }
  }
  if (home) {
    for (const name of AGENT_DIR_NAMES) {
      directories.push(path6.join(home, ".config", "opencode", name));
    }
  }
  return directories;
}

// src/model-fallback.ts
var MODEL_FALLBACK_MARKER = "\u258C **model fallback:**";
var MODEL_REFUSAL_ERROR_KINDS = ["model_not_found"];
var MODEL_REFUSAL_PATTERNS = [
  /There[’'`]?s an issue with the selected model/i
];
function firstText(content) {
  if (!Array.isArray(content)) return void 0;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      return block.text.trim();
    }
  }
  return void 0;
}
function modelRefusalFromAssistant(msg) {
  if (msg.type !== "assistant" || typeof msg.error !== "string") return null;
  if (!MODEL_REFUSAL_ERROR_KINDS.includes(msg.error)) return null;
  return { kind: "model_not_found", detail: firstText(msg.message?.content) };
}
function modelRefusalFromResult(msg) {
  if (msg.type !== "result" || msg.is_error !== true) return null;
  const text = typeof msg.result === "string" ? msg.result : "";
  if (!text || !MODEL_REFUSAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return null;
  }
  return { kind: "model_not_found", detail: text.trim() };
}
function provesModelServing(msg) {
  if (msg.type === "content_block_start" || msg.type === "content_block_delta") {
    return true;
  }
  if (msg.type !== "assistant") return false;
  if (msg.is_api_error_message === true) return false;
  return Array.isArray(msg.message?.content) && msg.message.content.length > 0;
}
function resolveFallbackChain(agent, modelId, overrides) {
  const record = agent ? (overrides?.records ?? getAgentRegistry())[agent] : void 0;
  if (record?.model?.includes("/")) return [];
  const declared = record?.fallbackModels?.length ? record.fallbackModels : (overrides ? overrides.providerFallbackModels : getProviderFallbackModels()) ?? [];
  if (declared.length === 0) return [];
  const source = record?.fallbackModels?.length ? `agent "${agent}"` : "provider";
  const chain = [];
  for (const wanted of declared) {
    const resolved = qualifyModelName(wanted, modelId);
    if (!resolved) {
      log.warn("fallback model refused: unknown model", {
        source,
        wanted,
        modelId
      });
      continue;
    }
    if (resolved === modelId || chain.includes(resolved)) continue;
    chain.push(resolved);
  }
  return chain;
}
function nextFallbackModel(chain, tried) {
  return chain.find((candidate) => !tried.has(candidate));
}
function describeRefusal(refusal) {
  return refusal.kind === "account_limit" ? "is out of usage on this account and no other account is configured" : "was refused by the Claude CLI (model_not_found: it is retired, misspelled, or this account cannot use it)";
}
function formatModelFallbackNote(input) {
  return `
${MODEL_FALLBACK_MARKER} "${input.failed}" ${describeRefusal(
    input.refusal
  )}, so this turn is being served by "${input.serving}" instead. The account, the thinking budget and the working directory are unchanged.
`;
}

// src/turn-stats.ts
var TURN_STATS_MARKER = "\u258C **stats:**";
function extractTurnStats(msg) {
  const usage = msg.usage;
  const stats = {};
  if (typeof msg.total_cost_usd === "number") stats.costUsd = msg.total_cost_usd;
  if (typeof msg.duration_ms === "number") stats.durationMs = msg.duration_ms;
  if (typeof msg.duration_api_ms === "number") stats.durationApiMs = msg.duration_api_ms;
  if (typeof msg.num_turns === "number") stats.numTurns = msg.num_turns;
  if (typeof usage?.input_tokens === "number") stats.inputTokens = usage.input_tokens;
  if (typeof usage?.output_tokens === "number") stats.outputTokens = usage.output_tokens;
  if (typeof usage?.cache_read_input_tokens === "number") {
    stats.cacheReadTokens = usage.cache_read_input_tokens;
  }
  if (typeof usage?.cache_creation_input_tokens === "number") {
    stats.cacheWriteTokens = usage.cache_creation_input_tokens;
  }
  if (msg.modelUsage && typeof msg.modelUsage === "object") stats.modelUsage = msg.modelUsage;
  if (Array.isArray(msg.permission_denials)) stats.permissionDenials = msg.permission_denials;
  return stats;
}
function formatCost(costUsd) {
  if (!Number.isFinite(costUsd) || costUsd < 0) return "$0.00";
  return costUsd >= 1 ? `$${costUsd.toFixed(2)}` : `$${costUsd.toFixed(4)}`;
}
function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0.0 s";
  if (durationMs < 6e4) return `${(durationMs / 1e3).toFixed(1)} s`;
  const totalSeconds = Math.round(durationMs / 1e3);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}
function formatTokens(tokens) {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1e3) return String(Math.round(tokens));
  if (tokens < 1e6) return `${(tokens / 1e3).toFixed(1)}k`;
  return `${(tokens / 1e6).toFixed(1)}M`;
}
function formatTurnStatsLine(stats) {
  const parts = [];
  if (stats.costUsd !== void 0) parts.push(formatCost(stats.costUsd));
  if (stats.durationMs !== void 0) parts.push(formatDuration(stats.durationMs));
  if (stats.numTurns !== void 0) {
    parts.push(`${stats.numTurns} CLI ${stats.numTurns === 1 ? "turn" : "turns"}`);
  }
  if (stats.inputTokens !== void 0) parts.push(`in ${formatTokens(stats.inputTokens)}`);
  if (stats.outputTokens !== void 0) parts.push(`out ${formatTokens(stats.outputTokens)}`);
  if (stats.cacheReadTokens) parts.push(`cache read ${formatTokens(stats.cacheReadTokens)}`);
  if (stats.cacheWriteTokens) parts.push(`cache write ${formatTokens(stats.cacheWriteTokens)}`);
  if (stats.permissionDenials?.length) {
    const count = stats.permissionDenials.length;
    parts.push(`${count} permission ${count === 1 ? "denial" : "denials"}`);
  }
  if (parts.length === 0) return null;
  return `${TURN_STATS_MARKER} ${parts.join(" \xB7 ")}`;
}
function formatTurnStatsBlock(stats) {
  const line = formatTurnStatsLine(stats);
  return line === null ? null : `
${line}
`;
}
function turnStatsLogPayload(stats) {
  return {
    costUsd: stats.costUsd ?? null,
    durationMs: stats.durationMs ?? null,
    durationApiMs: stats.durationApiMs ?? null,
    numTurns: stats.numTurns ?? null,
    inputTokens: stats.inputTokens ?? null,
    outputTokens: stats.outputTokens ?? null,
    cacheReadTokens: stats.cacheReadTokens ?? null,
    cacheWriteTokens: stats.cacheWriteTokens ?? null,
    modelUsage: stats.modelUsage ?? null,
    permissionDenials: stats.permissionDenials?.length ?? 0
  };
}

// src/message-builder.ts
var PLUGIN_NOTE_MARKERS = [
  INLINE_ASIDE_MARKER,
  ...LEGACY_INLINE_ASIDE_MARKERS,
  TURN_STATS_MARKER,
  COMPACT_BOUNDARY_MARKER,
  CONVERSATION_RESET_MARKER,
  RATE_LIMIT_MARKER,
  RESULT_ERROR_MARKER,
  DOCTOR_MARKER,
  STREAM_TIMEOUT_MARKER,
  SILENT_TURN_MARKER,
  FAILOVER_MARKER,
  ACCOUNT_BLOCK_MARKER,
  MODEL_FALLBACK_MARKER
];
function isPluginNote(part) {
  if (!part || part.type !== "text" || typeof part.text !== "string") return false;
  const text = part.text.trimStart();
  return PLUGIN_NOTE_MARKERS.some((marker) => text.startsWith(marker));
}
function stripPluginNotes(content) {
  if (!Array.isArray(content)) return content;
  const kept = content.filter((part) => !isPluginNote(part));
  return kept.length === content.length ? content : kept;
}
function filterSideQuestionHistory(prompt) {
  prompt = stripAccountFailoverParts(prompt);
  let pluginCommand = false;
  const kept = prompt.filter((message) => {
    if (message.role === "user") {
      pluginCommand = parseSideQuestionContent(message.content) !== null || parseDoctorCommandContent(message.content) !== null;
      return !pluginCommand;
    }
    return message.role !== "assistant" || !pluginCommand;
  });
  return kept.map(
    (message) => message.role === "assistant" ? { ...message, content: stripPluginNotes(message.content) } : message
  );
}
var DCP_REMINDER_BLOCK = /<dcp-system-reminder\b[^>]*>[\s\S]*?<\/dcp-system-reminder>/gi;
function stripContextReminderBlocks(text) {
  if (!text.includes("<dcp-system-reminder")) return text;
  return text.replace(DCP_REMINDER_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();
}
function shouldStripContextReminders(options) {
  if (options.enabled !== true) return false;
  const namesCompress = (list2) => (list2 ?? []).some((name) => String(name).trim().toLowerCase() === "compress");
  return !namesCompress(options.proxyTools) && !namesCompress(options.proxyOpencodeTools);
}
function stripContextReminders(prompt) {
  let removed = 0;
  const countIn = (text) => (text.match(DCP_REMINDER_BLOCK) ?? []).length;
  const out = prompt.map((message) => {
    if (message.role !== "user" && message.role !== "assistant") return message;
    if (!Array.isArray(message.content)) return message;
    let touched = false;
    const parts = message.content.map((part) => {
      if (!part || part.type !== "text" || typeof part.text !== "string") return part;
      const hits = countIn(part.text);
      if (hits === 0) return part;
      removed += hits;
      touched = true;
      return { ...part, text: stripContextReminderBlocks(part.text) };
    });
    return touched ? { ...message, content: parts } : message;
  });
  return removed > 0 ? { prompt: out, removed } : { prompt, removed: 0 };
}
var SUPPORTED_IMAGE_TYPES = /* @__PURE__ */ new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
]);
function toImageBlock(part) {
  const raw = part.image ?? part.data ?? part.url ?? part.source?.data;
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
  prompt = filterSideQuestionHistory(prompt);
  if (mode === "compaction") {
    return buildCompactionHistory(prompt);
  }
  const conversationMessages = prompt.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "tool"
  );
  if (conversationMessages.length <= 1) {
    return null;
  }
  const historyParts = [];
  for (let i = 0; i < conversationMessages.length - 1; i++) {
    const msg = conversationMessages[i];
    const role = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "Tool";
    const { text } = renderMessageContentForCompaction(msg);
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
function getClaudeUserMessage(prompt, includeHistoryContext = false, opts = {}) {
  const compactionMode = opts.compactionMode === true;
  const cliToolCallIds = opts.cliToolCallIds;
  const content = [];
  prompt = stripAccountFailoverParts(prompt);
  if (opts.stripContextReminders) {
    const stripped = stripContextReminders(prompt);
    if (stripped.removed > 0) {
      log.info("stripped unsatisfiable context reminders", {
        blocks: stripped.removed
      });
      prompt = stripped.prompt;
    }
  }
  const pushToolResult = (part) => {
    const id = part.toolCallId;
    const text = getToolResultText(part);
    if (!cliToolCallIds || cliToolCallIds.has(id)) {
      content.push({ type: "tool_result", tool_use_id: id, content: text });
      return;
    }
    log.info("rendering opencode-side tool result as text", {
      toolCallId: id,
      toolName: part.toolName,
      chars: text.length
    });
    content.push({
      type: "text",
      text: `<opencode_tool_result tool="${part.toolName ?? "unknown"}">
${text}
</opencode_tool_result>`
    });
  };
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
      if (parseSideQuestionContent(msg.content) !== null) continue;
      if (typeof msg.content === "string") {
        const str2 = msg.content;
        if (str2.trim()) {
          content.push({ type: "text", text: str2 });
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
            pushToolResult(part);
          }
        }
      }
    } else if (msg.role === "tool") {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part?.type === "tool-result") {
            pushToolResult(part);
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
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content
    }
  });
}

// src/skill-bridge.ts
import * as crypto3 from "crypto";
import * as fs5 from "fs";
import * as os3 from "os";
import * as path7 from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
var SKILL_PLUGIN_NAME = "opencode-skills";
function bundledSkillsDir() {
  try {
    const here = fileURLToPath2(import.meta.url);
    const dir = path7.resolve(path7.dirname(here), "..", "skills");
    return dirExists2(dir) ? dir : null;
  } catch {
    return null;
  }
}
function dirExists2(p) {
  try {
    return fs5.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function realPath(p) {
  try {
    return fs5.realpathSync(p);
  } catch {
    return path7.resolve(p);
  }
}
function envEnabled(name) {
  const value = process.env[name];
  if (value === void 0) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}
var SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
var FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---/;
var FRONTMATTER_NAME = /^name:[ \t]*(.+?)[ \t]*$/m;
function declaredSkillName(source) {
  const block = FRONTMATTER_BLOCK.exec(source);
  if (!block) return null;
  const line = FRONTMATTER_NAME.exec(block[1]);
  if (!line) return null;
  const name = line[1].trim().replace(/^["']|["']$/g, "").trim();
  return SAFE_SKILL_NAME.test(name) ? name : null;
}
function readSkill(root, entry) {
  const dir = path7.join(root, entry);
  let source;
  try {
    source = fs5.readFileSync(path7.join(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  return {
    name: declaredSkillName(source) ?? entry,
    dir,
    realDir: realPath(dir),
    contentHash: crypto3.createHash("sha256").update(source).digest("hex")
  };
}
function sameSkill(a, b) {
  return a.realDir === b.realDir || a.contentHash === b.contentHash;
}
function skillRoots(cwd) {
  const roots = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (p) => {
    const abs = path7.resolve(p);
    if (seen.has(abs)) return;
    seen.add(abs);
    if (dirExists2(abs)) roots.push(abs);
  };
  const home = os3.homedir();
  const homeDir = home ? path7.resolve(home) : null;
  let current = path7.resolve(cwd);
  while (true) {
    push(path7.join(current, ".opencode", "skills"));
    if (current !== homeDir) {
      push(path7.join(current, ".claude", "skills"));
      push(path7.join(current, ".agents", "skills"));
    }
    const parent = path7.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (homeDir) push(path7.join(homeDir, ".opencode", "skills"));
  const envDir = process.env.OPENCODE_CONFIG_DIR;
  if (envDir) {
    push(path7.join(envDir, "skills"));
    push(path7.join(envDir, "skill"));
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? (homeDir ? path7.join(homeDir, ".config") : null);
  if (xdg) {
    push(path7.join(xdg, "opencode", "skills"));
    push(path7.join(xdg, "opencode", "skill"));
  }
  if (homeDir && !envEnabled("OPENCODE_DISABLE_EXTERNAL_SKILLS")) {
    if (!envEnabled("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS")) {
      push(path7.join(homeDir, ".claude", "skills"));
    }
    push(path7.join(homeDir, ".agents", "skills"));
  }
  return roots;
}
function collectSkills(root, claimed, found) {
  let entries;
  try {
    entries = fs5.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    const skill = readSkill(root, entry.name);
    if (!skill) continue;
    const winner = claimed.get(skill.name);
    if (winner) {
      if (!sameSkill(winner, skill)) {
        log.warn("two different skills share a name; bridging the one the nearest root claimed", {
          name: skill.name,
          bridged: winner.dir,
          ignored: skill.dir
        });
      }
      continue;
    }
    claimed.set(skill.name, skill);
    found.push(skill);
  }
}
var byName = (a, b) => a.name.localeCompare(b.name);
function discoverOpencodeSkills(cwd) {
  const found = [];
  const claimed = /* @__PURE__ */ new Map();
  for (const root of skillRoots(cwd)) collectSkills(root, claimed, found);
  return found.sort(byName);
}
function discoverBundledSkills() {
  const root = bundledSkillsDir();
  if (!root) return [];
  const found = [];
  collectSkills(root, /* @__PURE__ */ new Map(), found);
  return found.sort(byName);
}
function claudeConfigDir(configDir) {
  const explicit = configDir ?? process.env.CLAUDE_CONFIG_DIR;
  if (explicit) return path7.resolve(expandHome(explicit));
  const home = os3.homedir();
  return home ? path7.resolve(home, ".claude") : null;
}
function installedPluginSkillRoots(configDir, cwd) {
  if (!configDir) return [];
  let parsed;
  try {
    parsed = JSON.parse(
      fs5.readFileSync(path7.join(configDir, "plugins", "installed_plugins.json"), "utf8")
    );
  } catch {
    return [];
  }
  const plugins = parsed?.plugins;
  if (!plugins || typeof plugins !== "object") return [];
  const workspace = path7.resolve(cwd);
  const roots = [];
  for (const installs of Object.values(plugins)) {
    if (!Array.isArray(installs)) continue;
    for (const install of installs) {
      const entry = install;
      if (typeof entry?.installPath !== "string" || !entry.installPath) continue;
      if (entry.scope !== "user" && !coversWorkspace(entry.projectPath, workspace)) continue;
      roots.push(path7.join(entry.installPath, "skills"));
    }
  }
  return roots;
}
function coversWorkspace(projectPath, workspace) {
  if (typeof projectPath !== "string" || !projectPath) return false;
  const root = path7.resolve(projectPath);
  if (root === workspace) return true;
  const rel = path7.relative(root, workspace);
  return rel !== "" && !rel.startsWith("..") && !path7.isAbsolute(rel);
}
function discoverNativeClaudeSkills(opts) {
  const found = [];
  const scanned = /* @__PURE__ */ new Set();
  const scan = (root, scope) => {
    const abs = path7.resolve(root);
    if (scanned.has(abs)) return;
    scanned.add(abs);
    let entries;
    try {
      entries = fs5.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      const skill = readSkill(abs, entry.name);
      if (skill) found.push({ ...skill, scope });
    }
  };
  const configDir = claudeConfigDir(opts.configDir);
  if (configDir) scan(path7.join(configDir, "skills"), "user");
  const home = os3.homedir();
  const homeDir = home ? path7.resolve(home) : null;
  let current = path7.resolve(opts.cwd);
  while (true) {
    if (current !== homeDir) scan(path7.join(current, ".claude", "skills"), "project");
    const parent = path7.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const root of installedPluginSkillRoots(configDir, opts.cwd)) scan(root, "plugin");
  return found;
}
function dropNativelyLoadedSkills(skills, native) {
  if (native.length === 0) return { bridged: skills, skipped: [] };
  const bridged = [];
  const skipped = [];
  for (const skill of skills) {
    const sameCopy = native.find((n) => n.realDir === skill.realDir);
    const sameContent = sameCopy ?? native.find((n) => n.contentHash === skill.contentHash);
    const nameTaken = sameContent ?? native.find((n) => n.scope !== "plugin" && n.name === skill.name);
    if (!nameTaken) {
      bridged.push(skill);
      continue;
    }
    const reason = sameCopy ? "same-copy" : sameContent ? "same-content" : "name-taken";
    skipped.push({ skill, native: nameTaken, reason });
    if (reason === "name-taken") {
      log.warn("claude already registers a different skill under this name; not bridging ours", {
        name: skill.name,
        claudeLoads: nameTaken.dir,
        notBridged: skill.dir,
        scope: nameTaken.scope
      });
    }
  }
  return { bridged, skipped };
}
function readBundledSkillInfos() {
  return discoverBundledSkills().flatMap((skill) => {
    const file = path7.join(skill.dir, "SKILL.md");
    let text;
    try {
      text = fs5.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    const frontmatter = match?.[1] ?? "";
    const field = (key) => {
      const line = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]?.trim();
      return line ? line.replace(/^(["'])(.*)\1$/, "$2") : void 0;
    };
    const description = field("description");
    return [
      {
        id: skill.name,
        name: field("name") ?? skill.name,
        ...description ? { description } : {},
        path: file,
        content: match ? text.slice(match[0].length) : text
      }
    ];
  });
}
function linkSkill(source, target) {
  try {
    fs5.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    return;
  } catch {
    fs5.cpSync(source, target, { recursive: true, dereference: true });
  }
}
function fileExists2(p) {
  try {
    return fs5.statSync(p).isFile();
  } catch {
    return false;
  }
}
function buildSkillPluginDir(skills) {
  if (skills.length === 0) return null;
  const fingerprint = skills.map((s) => `${s.name}\0${s.dir}`).join("\n");
  const hash = crypto3.createHash("sha256").update(fingerprint).digest("hex").slice(0, 12);
  const root = path7.join(pluginTmpDir(), `skills-${hash}`);
  const manifest = path7.join(root, ".claude-plugin", "plugin.json");
  if (fileExists2(manifest)) return root;
  try {
    fs5.rmSync(root, { recursive: true, force: true });
    fs5.mkdirSync(path7.join(root, ".claude-plugin"), { recursive: true });
    fs5.mkdirSync(path7.join(root, "skills"), { recursive: true });
    fs5.writeFileSync(
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
      linkSkill(skill.dir, path7.join(root, "skills", skill.name));
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
function registerBundledSkillPath(config) {
  const dir = bundledSkillsDir();
  if (!dir) return false;
  config.skills ??= {};
  const paths = config.skills.paths ??= [];
  if (paths.some((p) => path7.resolve(p) === dir)) return false;
  paths.push(dir);
  return true;
}
async function resolveSkillPluginDirs(opts) {
  const user = opts.enabled ? discoverOpencodeSkills(opts.cwd) : [];
  const claimed = new Set(user.map((s) => s.name));
  const bundled = discoverBundledSkills().filter((s) => !claimed.has(s.name));
  let skills = [...user, ...bundled].sort(byName);
  if (opts.skipNative !== false && skills.length > 0) {
    const native = discoverNativeClaudeSkills({ cwd: opts.cwd, configDir: opts.configDir });
    const { bridged, skipped } = dropNativelyLoadedSkills(skills, native);
    if (skipped.length > 0) {
      log.info("skills claude code already loads; left unbridged", {
        count: skipped.length,
        skipped: skipped.map((s) => ({
          name: s.skill.name,
          reason: s.reason,
          opencode: s.skill.dir,
          claude: s.native.dir
        }))
      });
    }
    skills = bridged;
  }
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
    bundled: bundled.map((s) => s.name),
    pluginDir: dir
  });
  return [dir];
}

// src/claude-session-wrapper.ts
import { EventEmitter as EventEmitter4 } from "events";
import { unlink as unlink2 } from "fs/promises";

// src/claude-session-bun.ts
import * as os4 from "os";
import * as fs6 from "fs";
import * as path8 from "path";
import { execFileSync } from "child_process";
import { randomUUID as randomUUID4 } from "crypto";
function resolveClaude(cmd = "claude") {
  if (path8.isAbsolute(cmd) && fs6.existsSync(cmd)) return cmd;
  const viaBun = Bun.which(cmd);
  if (viaBun) return viaBun;
  const isWin = os4.platform() === "win32";
  try {
    const out = execFileSync(isWin ? "where" : "which", [cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).find((p) => fs6.existsSync(p));
    if (first) return first;
  } catch {
  }
  throw new Error(`Could not resolve command on PATH: ${cmd}`);
}
function encodeCwd(cwd) {
  return path8.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}
function interactiveSpawnEnv(opts) {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: opts.configDir,
    TERM: "xterm-256color",
    // Pin the binary so a mid-session autoupdate cannot invalidate the
    // detected version the flag gates read, and skip non-essential traffic.
    // Fills gaps only, so a var the user exported survives untouched.
    ...cliHygieneEnv(),
    ...opts.ignoreAnthropicApiKey ? { ANTHROPIC_API_KEY: void 0, ANTHROPIC_AUTH_TOKEN: void 0 } : {},
    ...opts.effort ? { CLAUDE_CODE_EFFORT_LEVEL: opts.effort } : {}
  };
}
var TERMINAL_STOP = /* @__PURE__ */ new Set(["end_turn", "stop_sequence", "max_tokens"]);
var delay = (ms) => new Promise((r) => setTimeout(r, ms));
function resolveConfigDir(configDir) {
  const value = configDir ?? process.env.CLAUDE_CONFIG_DIR;
  if (!value) return path8.join(os4.homedir(), ".claude");
  if (value === "~") return os4.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path8.join(os4.homedir(), value.slice(2));
  }
  return path8.resolve(value);
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
    this.cwd = path8.resolve(opts.cwd ?? process.cwd());
    this.configDir = resolveConfigDir(opts.configDir);
    this.signal = opts.signal;
    this.sessionId = randomUUID4();
    this.jsonlPath = path8.join(
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
      effort: opts.effort,
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
      env: interactiveSpawnEnv({
        // The resolved field, not `this.o.configDir`: same value (the
        // constructor copies it in) but typed as always present.
        configDir: this.configDir,
        ignoreAnthropicApiKey: this.o.ignoreAnthropicApiKey,
        effort: this.o.effort
      }),
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
      return fs6.readFileSync(this.jsonlPath, "utf8").split("\n");
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
function interactiveExtraArgs(opts) {
  const extraArgs = [];
  if (opts.mcpConfigPaths && opts.mcpConfigPaths.length > 0) {
    extraArgs.push(
      "--mcp-config",
      ...opts.mcpConfigPaths,
      "--strict-mcp-config"
    );
  }
  for (const dir of opts.pluginDirs ?? []) {
    extraArgs.push("--plugin-dir", dir);
  }
  const flagSettings = {};
  if (opts.permissionsAllow && opts.permissionsAllow.length > 0) {
    flagSettings.permissions = { allow: opts.permissionsAllow };
  }
  if (opts.fastMode) {
    flagSettings.fastMode = true;
  }
  if (Object.keys(flagSettings).length > 0) {
    extraArgs.push("--settings", JSON.stringify(flagSettings));
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
  return extraArgs;
}
function spawnInteractiveProcess(opts) {
  const extraArgs = interactiveExtraArgs(opts);
  const session = new ClaudeSession({
    cwd: opts.cwd,
    cliPath: opts.cliPath,
    configDir: opts.configDir,
    model: opts.model,
    // Default null = normal CLAUDE.md + settings load, matching what the
    // headless spawn does. "" (skip everything) is for fast e2e runs only.
    settingSources: opts.settingSources === void 0 ? null : opts.settingSources,
    extraArgs,
    ignoreAnthropicApiKey: opts.ignoreAnthropicApiKey,
    effort: opts.effort ? cliEffortLevel(opts.effort) : void 0
  });
  log.info("prepared interactive claude session", {
    cwd: opts.cwd,
    cliPath: opts.cliPath ?? "claude",
    configDir: session.configDir,
    model: opts.model,
    effort: opts.effort,
    sessionId: session.sessionId,
    jsonlPath: session.jsonlPath
  });
  const lineEmitter = new EventEmitter4();
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
    systemPromptFile: opts.systemPromptFile
  };
}

// src/prompts.ts
import { readFileSync as readFileSync5, writeFileSync as writeFileSync4 } from "fs";
import { homedir as homedir6 } from "os";
import { randomUUID as randomUUID5 } from "crypto";
import { dirname as dirname5, join as join8 } from "path";
function readPromptFileIfPresent(path10) {
  try {
    const content = readFileSync5(path10, "utf8").trim();
    return content || void 0;
  } catch {
    return void 0;
  }
}
function nearestWorkspaceAgentsPrompt(cwd) {
  let dir = cwd;
  while (true) {
    const content = readPromptFileIfPresent(join8(dir, "AGENTS.md"));
    if (content) return content;
    const parent = dirname5(dir);
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
var SUBAGENT_DISPATCH_HINT = `## opencode subagents

Subagent dispatch in this environment goes through exactly two tools: \`mcp__opencode_proxy__task\` for one subagent and \`mcp__opencode_proxy__task_batch\` for two or more at once.

- Two or more independent subagents in one response: make ONE \`mcp__opencode_proxy__task_batch\` call with a \`tasks\` array (each item is a normal task input). Claude Code runs MCP calls one at a time, so several \`mcp__opencode_proxy__task\` calls in the same response run serially; \`task_batch\` runs them concurrently in opencode and returns every result together, labelled in order.
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
var CLAUDE_CLI_COMPRESS_NOTE = `## Runtime environment: Claude Code CLI

You are running via the Claude Code CLI (not a direct API call). This affects context management:

- To compress context, call \`mcp__opencode_proxy__compress\` with a \`summary\` argument. Use that exact full name.
- The reset happens at the start of your NEXT turn: this Claude Code session is discarded and a fresh one starts with your summary as its only prior context. Keep working normally after the call.
- Everything outside the summary is gone after the reset \u2014 tool output, files you read, and the earlier conversation are not replayed. Write the summary as the authoritative record.
- The \`distill\`, \`prune\`, and \`extract\` tools are NOT available.
- DCP context injections (AGENTS.md, dynamic state) arrive via the system prompt and are already applied.`;
var CLAUDE_CLI_OPENCODE_COMPRESS_NOTE = `## Runtime environment: Claude Code CLI

You are running via the Claude Code CLI (not a direct API call). This affects context management:

- To compress context, call \`mcp__opencode_proxy__compress\`. Use that exact full name. It runs opencode's own \`compress\` tool, which is what a "MAX CONTEXT LIMIT REACHED" reminder is asking you to do.
- It compresses opencode's stored conversation, NOT this Claude Code session. Your current session keeps the context it already has, so do not assume earlier detail is gone after the call.
- The \`distill\`, \`prune\`, and \`extract\` tools are NOT available.
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
function buildAppendedSystemPrompt(cwd, includeMultiStepHint = true, extraSystemContent = [], options = {}) {
  const parts = [];
  if (options.compressionSummary?.trim()) {
    parts.push(
      `## Summary of earlier work (context was compressed)

${options.compressionSummary.trim()}`
    );
  }
  parts.push(
    options.compressEnabled ? CLAUDE_CLI_COMPRESS_NOTE : options.opencodeCompressEnabled ? CLAUDE_CLI_OPENCODE_COMPRESS_NOTE : CLAUDE_CLI_CONTEXT_NOTE
  );
  for (const s of extraSystemContent) {
    if (s.trim()) parts.push(s.trim());
  }
  const configRoot = process.env.XDG_CONFIG_HOME ?? join8(homedir6(), ".config");
  const globalAgents = readPromptFileIfPresent(join8(configRoot, "opencode", "AGENTS.md"));
  const workspaceAgents = nearestWorkspaceAgentsPrompt(cwd);
  const forwarded = extraSystemContent.join("\n\n");
  const pushGlobal = !!globalAgents && !forwarded.includes(globalAgents);
  const pushWorkspace = !!workspaceAgents && workspaceAgents !== globalAgents && !forwarded.includes(workspaceAgents);
  if (pushGlobal) parts.push(globalAgents);
  if (pushWorkspace) parts.push(workspaceAgents);
  if (pushGlobal || pushWorkspace) parts.push(AGENTS_MAINTENANCE_HINT);
  if (includeMultiStepHint) parts.push(MULTI_STEP_TASK_HINT);
  const content = parts.join("\n\n");
  if (!content) return void 0;
  const path10 = join8(pluginTmpDir(), `opencode-cc-sys-${randomUUID5()}.md`);
  try {
    writeFileSync4(path10, content, { encoding: "utf8", mode: 384 });
    return path10;
  } catch (err) {
    log.warn("failed to write system prompt file", { error: String(err) });
    return void 0;
  }
}

// src/auto-continue.ts
var AUTO_CONTINUE_MAX_ATTEMPTS = 8;
var AUTO_CONTINUE_MAX_ELAPSED_MS = 10 * 60 * 1e3;
var AUTO_CONTINUE_NO_PROGRESS_LIMIT = 2;
var AUTO_CONTINUE_PROMPT = "Continue the task from where you stopped. Do not summarize; keep working until the requested task is complete, you need clarification, or you hit a real blocker.";
function autoContinueEnabledFor(compactionMode, configured) {
  return compactionMode ? false : configured;
}
function isTruncationStopReason(stopReason) {
  return stopReason === "max_tokens" || stopReason === "max_output_tokens";
}
function normalizeVisibleText(text) {
  return text.replace(/\s+/g, " ").trim();
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
    if (isTruncationStopReason(snapshot.stopReason)) {
      if (state.attempts >= AUTO_CONTINUE_MAX_ATTEMPTS) {
        return { continue: false, reason: "max-attempts" };
      }
      const truncatedAt = snapshot.now ?? Date.now();
      if (truncatedAt - state.startedAt > AUTO_CONTINUE_MAX_ELAPSED_MS) {
        return { continue: false, reason: "max-elapsed" };
      }
      return { continue: true, reason: "truncated" };
    }
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
function isSilentTurn(snapshot) {
  if (snapshot.enabled === false) return false;
  if (snapshot.compactionMode) return false;
  if (snapshot.isError) return false;
  if (snapshot.aborted) return false;
  if (snapshot.sawQuestion) return false;
  return !snapshot.sawVisibleText && !snapshot.sawToolActivity && !snapshot.sawProxyActivity;
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

// src/call-options.ts
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
function resolveOpencodeAgent(headers, providerOptions, providerKey) {
  if (providerOptions) {
    const bag = providerOptions[providerKey] ?? providerOptions["claude-code"];
    const agent = bag?.opencodeAgent;
    if (typeof agent === "string") return agent;
  }
  if (headers) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "x-opencode-agent") {
        const value = headers[key];
        if (typeof value === "string" && value.length > 0) return value;
      }
    }
  }
  return void 0;
}
function describeAbortReason(reason) {
  if (reason === void 0) return "undefined";
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason) ?? typeof reason;
  } catch {
    return typeof reason;
  }
}
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

// src/proxy-results.ts
function makeLateProxyResultMessage(entries) {
  const sections = entries.map(({ call, result }) => {
    const failed = result.kind === "error" || result.isError === true;
    const body = result.kind === "error" ? result.message : result.text;
    return `Your earlier \`${call.toolName}\` tool call (id ${call.toolCallId}) has ${failed ? "failed" : "completed"}, but delivery or continuation was interrupted. Treat the following as its ${failed ? "error" : "result"} and continue from there; do not re-run it.

${body}`;
  });
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: sections.join("\n\n---\n\n") }]
    }
  });
}
function extractPendingProxyResult(prompt, toolCallId) {
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
function extractPendingProxyResultForCall(prompt, call) {
  if (call.toolName !== TASK_BATCH_TOOL_NAME) {
    return extractPendingProxyResult(prompt, call.toolCallId);
  }
  const tasks = taskBatchTasks(call.input);
  if (tasks.length === 0) {
    return { kind: "error", message: "task_batch input is not a list of task objects" };
  }
  const children = tasks.map((task, index) => ({
    task,
    result: extractPendingProxyResult(
      prompt,
      taskBatchChildToolCallId(call.toolCallId, index)
    )
  }));
  const answered = children.filter((child) => child.result !== null).length;
  if (answered === 0) return null;
  if (answered < children.length) {
    log.warn("task_batch resolving with child results missing", {
      toolCallId: call.toolCallId,
      answered,
      total: children.length
    });
  }
  return formatTaskBatchResults(children);
}

// src/ask-user-question.ts
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

// src/control-request.ts
function controlRequestBehaviorForTool(config, toolName) {
  const configured = config.controlRequestToolBehaviors;
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
  return config.controlRequestBehavior ?? "allow";
}
function writeControlResponse(proc, requestId, response) {
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
function handleControlRequest(config, msg, proc) {
  if (msg.type !== "control_request") return false;
  const requestId = msg.request_id;
  const request = msg.request;
  if (!requestId || !request?.subtype) return false;
  if (request.subtype === "can_use_tool") {
    const toolName = request.tool_name ?? "unknown";
    const behavior = controlRequestBehaviorForTool(config, toolName);
    if (behavior === "allow") {
      writeControlResponse(proc, requestId, {
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
        config.controlRequestDenyMessage
      );
      writeControlResponse(proc, requestId, {
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
  writeControlResponse(proc, requestId, {});
  log.debug("control request acknowledged", {
    requestId,
    subtype: request.subtype
  });
  return true;
}

// src/spawn-planning.ts
function effectiveMcpConfig(config, cwd, proxyConfigPath, runtimeStatus, excludeServers) {
  const paths = Array.isArray(config.mcpConfig) ? config.mcpConfig.slice() : config.mcpConfig ? [config.mcpConfig] : [];
  let bridgedHash = null;
  let allEnabledServerNames = [];
  if (config.bridgeOpencodeMcp !== false) {
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
function resolvedProxyTools(config) {
  const names = config.proxyTools;
  if (!names || names.length === 0) return null;
  const defsByName = new Map(
    DEFAULT_PROXY_TOOLS.map((t) => [t.name.toLowerCase(), t])
  );
  const picked = [];
  const seen = /* @__PURE__ */ new Set();
  const unknown = [];
  const pick = (def) => {
    if (seen.has(def.name)) return;
    seen.add(def.name);
    picked.push(def);
  };
  for (const n of names) {
    const def = defsByName.get(String(n).toLowerCase());
    if (!def) {
      unknown.push(String(n));
      continue;
    }
    pick(def);
    if (def.name === "task") {
      const batch = defsByName.get(TASK_BATCH_TOOL_NAME);
      if (batch) pick(batch);
    }
  }
  if (unknown.length > 0) {
    const known = [...defsByName.keys()].join(", ");
    if (picked.length === 0) {
      log.warn(
        "no proxyTools entry was recognised; nothing will be proxied this turn",
        { unknown, known }
      );
    } else {
      log.warn("ignoring unknown proxyTools entries", { unknown, known });
    }
  }
  return picked.length > 0 ? picked : null;
}
function resolvedProxyMcpTools(config, allEnabledServerNames, modelTools, taken) {
  if (config.proxyOpencodeMcpTools !== true) return null;
  if (config.bridgeOpencodeMcp === false) return null;
  if (allEnabledServerNames.length === 0) return null;
  const resolution = resolveMcpProxyToolDefs({
    serverNames: allEnabledServerNames,
    tools: modelTools,
    taken
  });
  if (resolution.defs.length === 0) {
    log.warn(
      "proxyOpencodeMcpTools is on but no MCP tool was found in opencode's tool set; those servers stay on the direct bridge this spawn",
      { servers: allEnabledServerNames, modelTools: modelTools?.length ?? 0 }
    );
    return null;
  }
  log.debug("routing opencode MCP tools through the proxy", {
    servers: [...resolution.coveredServers],
    tools: resolution.defs.map((def) => def.name)
  });
  return resolution;
}
async function fetchLiveToolInfo(config, modelId) {
  const items = await fetchOpencodeToolList(
    config.provider,
    modelId,
    config.cwd
  );
  const question = items?.find((item) => item.id === "question");
  return {
    resolved: items !== void 0,
    taskDescription: items?.find((item) => item.id === "task")?.description,
    questionDescription: question?.description,
    hasQuestion: !!question,
    items
  };
}
function stripContextRemindersEnabled(config) {
  return shouldStripContextReminders({
    enabled: config.stripContextReminders,
    proxyTools: config.proxyTools,
    proxyOpencodeTools: config.proxyOpencodeTools
  });
}
function skillBridgeSpawn(config, failover) {
  return {
    configDir: failover.failedOver && failover.target ? accountConfigDirPath(failover.target) : config.configDir,
    skipNative: config.bridgeSkipNativeSkills !== false
  };
}
function createLiveToolInfoLoader(config, modelId) {
  let pending;
  return () => {
    pending ??= fetchLiveToolInfo(config, modelId);
    return pending;
  };
}
async function resolvePlanModeQuestion(config, compactionMode, loadLiveToolInfo) {
  if (compactionMode || config.planModeQuestion !== true) return false;
  const info = await loadLiveToolInfo();
  const active = isPlanModeQuestionActive({
    configured: config.planModeQuestion,
    opencodeHasQuestion: info.hasQuestion,
    compactionMode
  });
  if (!active) {
    log.info("plan-mode question gate", {
      opencodeHasQuestion: info.hasQuestion,
      registryResolved: info.resolved,
      active
    });
  }
  return active;
}
async function ensureProxyServer(config, tools, sessionKeyForCalls, interceptCompress) {
  const timeoutOverrides = config.proxyToolTimeoutMs;
  const interceptors = /* @__PURE__ */ new Map();
  if (interceptCompress && tools.some((t) => t.name === "compress")) {
    interceptors.set("compress", (input) => {
      const summary = typeof input.summary === "string" ? input.summary.trim() : "";
      if (!summary) {
        return {
          kind: "error",
          message: "compress needs a non-empty `summary`: it becomes the only prior context after the reset. Nothing was compressed."
        };
      }
      storeCompressionSummary(sessionKeyForCalls, summary);
      log.info("compress stored summary; session resets next turn", {
        sessionKey: sessionKeyForCalls,
        summaryLength: summary.length
      });
      return {
        kind: "text",
        text: "Summary stored. Finish this turn as normal; the next turn starts a fresh Claude Code session with this summary as its only prior context."
      };
    });
  }
  const srv = await createProxyMcpServer(tools, timeoutOverrides, interceptors);
  srv.calls.on("call", (call) => {
    queuePendingProxyCall(sessionKeyForCalls, call, timeoutOverrides);
  });
  return srv;
}

// src/title.ts
function isTitleRequest(config, scope, options) {
  if (scope === "no-tools") return true;
  return config.hostApi === "v2" && resolveOpencodeAgent(
    options?.headers,
    options.providerOptions,
    config.provider
  ) === "title";
}
function requestScope(options) {
  const tools = options?.tools;
  if (Array.isArray(tools)) return "tools";
  if (tools && typeof tools === "object") {
    return Object.keys(tools).length > 0 ? "tools" : "no-tools";
  }
  return "no-tools";
}
function latestUserText(prompt) {
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
function synthesizeTitle(prompt) {
  const source = latestUserText(prompt).replace(/\s+/g, " ").replace(/[^\p{L}\p{N}\s-]/gu, " ").trim();
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

// src/usage.ts
function toUsage(rawUsage) {
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
function lastCallContextUsage(lastCallUsage, turnTotalUsage) {
  if (!lastCallUsage || !turnTotalUsage) return turnTotalUsage;
  const iterations = lastCallUsage.iterations;
  const context = iterations?.length ? iterations[iterations.length - 1] : lastCallUsage;
  return {
    input_tokens: context.input_tokens,
    cache_read_input_tokens: context.cache_read_input_tokens,
    cache_creation_input_tokens: context.cache_creation_input_tokens,
    output_tokens: turnTotalUsage.output_tokens
  };
}
function toFinishReason(reason = "stop") {
  return {
    unified: reason,
    raw: reason
  };
}

// src/turn-state.ts
import { generateId } from "@ai-sdk/provider-utils";
function resolveResultFallbackMs() {
  const env = process.env.CLAUDE_CODE_RESULT_FALLBACK_MS;
  const parsed = env ? Number.parseInt(env, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 6e4;
}
function resolveStartWatchdogMs() {
  const env = process.env.CLAUDE_CODE_START_WATCHDOG_MS;
  const parsed = env ? Number.parseInt(env, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 9e4;
}
function unassigned() {
  return void 0;
}
function createTurnState(init) {
  const state = {
    controller: init.controller,
    sessionKey: init.sessionKey,
    cwd: init.cwd,
    cliPath: init.cliPath,
    ignoreAnthropicApiKey: init.ignoreAnthropicApiKey,
    toUsage: init.toUsage,
    toFinishReason: init.toFinishReason,
    resultFallbackMs: resolveResultFallbackMs(),
    startWatchdogMs: resolveStartWatchdogMs(),
    activeProcess: void 0,
    proc: unassigned(),
    lineEmitter: unassigned(),
    cliArgs: unassigned(),
    proxyServer: null,
    currentTextId: null,
    textBlockIndices: /* @__PURE__ */ new Set(),
    startTextBlock() {
      if (state.currentTextId) {
        state.controller.enqueue({ type: "text-end", id: state.currentTextId });
      }
      const id = generateId();
      state.currentTextId = id;
      state.controller.enqueue({ type: "text-start", id });
      return id;
    },
    endTextBlock() {
      if (state.currentTextId) {
        state.controller.enqueue({ type: "text-end", id: state.currentTextId });
        state.currentTextId = null;
      }
    },
    reasoningIds: /* @__PURE__ */ new Map(),
    reasoningStarted: /* @__PURE__ */ new Map(),
    hadThinkingTextFromStream: false,
    turnCompleted: false,
    controllerClosed: false,
    cleanedUp: false,
    unattendedTurnEnded: false,
    watchdogMessage: init.userMsg,
    pendingProxyUnsubscribe: null,
    asideSinkUnregister: null,
    resultFallbackTimer: null,
    startWatchdog: null,
    respawnAttempted: false,
    hasReceivedContent: false,
    hasReceivedProgress: false,
    gotPartialEvents: false,
    visibleTextSinceContinue: "",
    lastVisibleTextSinceContinue: "",
    hadReasoningSinceContinue: false,
    hadToolActivitySinceContinue: false,
    hadProxyActivitySinceContinue: false,
    sawVisibleText: false,
    sawReasoning: false,
    sawToolActivity: false,
    sawProxyActivity: false,
    lastStopReason: null,
    autoContinueState: {
      enabled: init.autoContinueEnabled,
      attempts: 0,
      startedAt: Date.now(),
      noProgressCount: 0
    },
    toolCallMap: /* @__PURE__ */ new Map(),
    skipResultForIds: /* @__PURE__ */ new Set(),
    toolCallsById: /* @__PURE__ */ new Map(),
    resultMeta: {},
    lastCallUsage: void 0,
    resultFailure: void 0,
    accountLimitHit: null,
    accountBlock: null,
    modelRefusal: null,
    drainBuffer: [],
    drainTimer: null,
    pendingResultCompletion: null,
    lineHandler: unassigned(),
    closeHandler: unassigned(),
    procErrorHandler: unassigned(),
    cleanupTurn: unassigned()
  };
  return state;
}

// src/stream-parser.ts
import { generateId as generateId2 } from "@ai-sdk/provider-utils";

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
function singleQuoteForShell(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
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
      const list2 = applyTaskUpdate(opts.sessionId, input);
      if (list2 !== null) return emitTodoWrite(list2);
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
        command: `printf '%s\\n' ${singleQuoteForShell(`TASK OUTPUT: ${String(output)}`)}`,
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

// src/fast-mode.ts
var FAST_MODE_REASONS = {
  sdk_opt_in_required: "the CLI did not receive the headless opt-in (--settings). This is a plugin bug, please report it",
  extra_usage_disabled: "your account has usage credits turned off. Run /usage-credits in an interactive `claude` session to enable them",
  free: "fast mode requires a paid subscription or purchased credits",
  preference: "fast mode is turned off for your organization",
  model_not_allowed: "this model is not in your organization's allowed models",
  not_first_party: "fast mode only works against the Anthropic API directly, not Bedrock / Vertex / Foundry",
  network_error: "the CLI could not reach Anthropic to check availability",
  disabled_by_env: "CLAUDE_CODE_DISABLE_FAST_MODE is set in the environment",
  pending: "the CLI is still checking availability"
};
var warnedFastModeReasons = /* @__PURE__ */ new Set();
function reportFastModeState(msg, requested) {
  const state = msg.fast_mode_state;
  if (!state) return;
  if (!requested) {
    log.debug("fast mode state", { state });
    return;
  }
  if (state === "on") {
    log.info("fast mode active", { state });
    return;
  }
  const reason = msg.fast_mode_disabled_reason;
  if (state === "cooldown") {
    log.notice(
      "fast mode is in cooldown after a rate limit; this turn runs at standard speed and is billed at standard Opus rates, not the fast price shown in the model picker.",
      { state, reason: reason ?? null }
    );
    return;
  }
  const key = reason ?? "unknown";
  const explanation = reason ? FAST_MODE_REASONS[reason] : void 0;
  const message = `fast mode was requested but is off${explanation ? `: ${explanation}` : reason ? ` (${reason})` : ""}. Turns run at standard speed and are billed at standard Opus rates, not the fast price shown in the model picker. Switch to the non-fast model id to make the picker's price accurate.`;
  if (warnedFastModeReasons.has(key)) {
    log.debug(message, { state, reason: reason ?? null });
    return;
  }
  warnedFastModeReasons.add(key);
  log.warn(message, { state, reason: reason ?? null });
}

// src/turn-controller.ts
var DRAIN_QUIET_MS = 100;
function clearFallbackTimer(state) {
  if (state.resultFallbackTimer) {
    clearTimeout(state.resultFallbackTimer);
    state.resultFallbackTimer = null;
  }
}
function startResultFallback(state, delayMs = state.resultFallbackMs) {
  clearFallbackTimer(state);
  if (!state.hasReceivedContent && !state.hasReceivedProgress || state.controllerClosed) return;
  state.resultFallbackTimer = setTimeout(() => {
    if (state.controllerClosed) return;
    log.warn("result fallback timer fired \u2014 closing stream without result event", {
      delayMs
    });
    if (!state.autoContinueState.aborted) {
      state.controller.enqueue({
        type: "text-delta",
        id: state.startTextBlock(),
        delta: formatStreamTimeoutNote(delayMs)
      });
      state.endTextBlock();
    }
    state.closeHandler();
  }, delayMs);
}
function clearStartWatchdog(state) {
  if (state.startWatchdog) {
    clearTimeout(state.startWatchdog);
    state.startWatchdog = null;
  }
}
function onStartWatchdogFire(state) {
  state.startWatchdog = null;
  if (state.controllerClosed || state.hasReceivedContent || state.hasReceivedProgress) return;
  if (state.respawnAttempted) {
    log.error(
      "claude process still silent after respawn; ending turn",
      { sessionKey: state.sessionKey }
    );
    deleteActiveProcess(state.sessionKey);
    deleteClaudeSessionId(state.sessionKey);
    state.controllerClosed = true;
    state.cleanupTurn();
    state.controller.enqueue({
      type: "error",
      error: new Error(
        "Claude process produced no output after the envelope write (start watchdog timeout)."
      )
    });
    try {
      state.controller.close();
    } catch {
    }
    return;
  }
  state.respawnAttempted = true;
  log.warn(
    "no stdout after envelope write; respawning claude process to resume conversation",
    { sessionKey: state.sessionKey, startWatchdogMs: state.startWatchdogMs }
  );
  state.lineEmitter.off("line", state.lineHandler);
  state.lineEmitter.off("close", state.closeHandler);
  state.proc.off("error", state.procErrorHandler);
  const newAp = respawnActiveProcess(
    state.sessionKey,
    state.cliPath,
    state.cliArgs,
    state.cwd,
    state.ignoreAnthropicApiKey
  );
  if (!newAp) {
    log.error(
      "no active process to respawn (start watchdog); ending turn",
      { sessionKey: state.sessionKey }
    );
    state.controllerClosed = true;
    state.cleanupTurn();
    state.controller.enqueue({
      type: "error",
      error: new Error(
        "No active claude process to respawn after start watchdog timeout."
      )
    });
    try {
      state.controller.close();
    } catch {
    }
    return;
  }
  state.proc = newAp.proc;
  state.lineEmitter = newAp.lineEmitter;
  state.activeProcess = newAp;
  state.lineEmitter.on("line", state.lineHandler);
  state.lineEmitter.on("close", state.closeHandler);
  state.proc.on("error", state.procErrorHandler);
  try {
    if (!deliverPendingCompletions(state, true)) {
      noteTurnStarted(newAp);
      state.proc.stdin?.write(state.watchdogMessage + "\n");
    }
    log.debug("re-sent user message after respawn", {
      textLength: state.watchdogMessage.length
    });
  } catch (err) {
    log.error("failed to re-send envelope after respawn", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
  armStartWatchdog(state);
}
function armStartWatchdog(state) {
  clearStartWatchdog(state);
  if (state.controllerClosed) return;
  state.startWatchdog = setTimeout(
    () => onStartWatchdogFire(state),
    state.startWatchdogMs
  );
}
function deliverPendingCompletions(state, force = false) {
  const pending = state.activeProcess?.pendingProxyCompletions;
  const entries = [...pending?.values() ?? []].filter(
    (entry) => force || entry.recoveryRequired || isPendingProxyCallChannelClosed(entry.call)
  );
  if (entries.length === 0) return false;
  state.endTextBlock();
  state.watchdogMessage = makeLateProxyResultMessage(entries);
  if (state.activeProcess) noteTurnStarted(state.activeProcess);
  state.proc.stdin.write(state.watchdogMessage + "\n");
  for (const { call } of entries) pending.delete(call.toolCallId);
  log.warn("delivering proxy results after interrupted continuation", {
    sessionKey: state.sessionKey,
    toolCallIds: entries.map(({ call }) => call.toolCallId),
    respawn: force
  });
  state.gotPartialEvents = false;
  state.hasReceivedContent = false;
  state.hasReceivedProgress = false;
  state.turnCompleted = false;
  resetAutoContinueWindow(state);
  clearFallbackTimer(state);
  armStartWatchdog(state);
  return true;
}
function finishWithToolCalls(state, calls) {
  if (state.controllerClosed) return;
  if (calls.length === 0) return;
  const enqueueToolCall = (toolCallId, toolName, input) => {
    state.controller.enqueue({
      type: "tool-input-start",
      id: toolCallId,
      toolName
    });
    state.controller.enqueue({
      type: "tool-call",
      toolCallId,
      toolName,
      input: JSON.stringify(input),
      providerExecuted: false
    });
    state.skipResultForIds.add(toolCallId);
  };
  for (const call of calls) {
    if (call.toolName === TASK_BATCH_TOOL_NAME) {
      for (const [index, task] of taskBatchTasks(call.input).entries()) {
        enqueueToolCall(
          taskBatchChildToolCallId(call.toolCallId, index),
          "task",
          task
        );
      }
      state.skipResultForIds.add(call.toolCallId);
    } else {
      enqueueToolCall(call.toolCallId, call.toolName, call.input);
    }
    markPendingProxyCallEmitted(call.toolCallId);
  }
  state.controller.enqueue({
    type: "finish",
    finishReason: state.toFinishReason("tool-calls"),
    // No result yet (the usual mid-turn boundary) still reports nothing.
    usage: state.toUsage(lastCallContextUsage(state.lastCallUsage, state.resultMeta.usage)),
    providerMetadata: {
      "claude-code": state.resultMeta
    }
  });
  state.controllerClosed = true;
  state.cleanupTurn();
  try {
    state.controller.close();
  } catch {
  }
}
function finishWithQuestionCall(state, call) {
  if (state.controllerClosed) return;
  state.endTextBlock();
  state.controller.enqueue({
    type: "tool-input-start",
    id: call.toolCallId,
    toolName: call.toolName,
    providerExecuted: false
  });
  state.controller.enqueue({
    type: "tool-call",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: JSON.stringify(call.input),
    providerExecuted: false
  });
  state.controller.enqueue({
    type: "finish",
    finishReason: state.toFinishReason("tool-calls"),
    usage: state.toUsage(lastCallContextUsage(state.lastCallUsage, state.resultMeta.usage)),
    providerMetadata: {
      "claude-code": state.resultMeta
    }
  });
  state.controllerClosed = true;
  state.cleanupTurn();
  try {
    state.controller.close();
  } catch {
  }
}
function drainNow(state) {
  if (state.drainTimer) {
    clearTimeout(state.drainTimer);
    state.drainTimer = null;
  }
  if (state.drainBuffer.length === 0) return;
  if (state.controllerClosed) return;
  const batch = state.drainBuffer.splice(0, state.drainBuffer.length);
  log.info("draining pending proxy calls into stream finish", {
    sessionKey: state.sessionKey,
    count: batch.length,
    toolCallIds: batch.map((c) => c.toolCallId)
  });
  finishWithToolCalls(state, batch);
}
function settleResultBoundary(state) {
  state.drainTimer = null;
  const completeResult = state.pendingResultCompletion;
  state.pendingResultCompletion = null;
  if (!completeResult || state.controllerClosed) return;
  if (state.drainBuffer.length > 0) {
    drainNow(state);
    return;
  }
  completeResult();
}
function scheduleResultBoundary(state, completeResult, delayMs) {
  state.pendingResultCompletion = completeResult;
  if (state.drainTimer) clearTimeout(state.drainTimer);
  state.drainTimer = setTimeout(() => settleResultBoundary(state), delayMs);
}
function noteResultBoundaryCall(state) {
  if (!state.pendingResultCompletion) return false;
  if (state.drainTimer) clearTimeout(state.drainTimer);
  state.drainTimer = setTimeout(() => settleResultBoundary(state), DRAIN_QUIET_MS);
  return true;
}
function noteVisibleText(state, text) {
  state.visibleTextSinceContinue += text;
  state.lastVisibleTextSinceContinue += text;
  if (text.length > 0) state.sawVisibleText = true;
}
function resetLastVisibleTextBlock(state) {
  state.lastVisibleTextSinceContinue = "";
}
function noteReasoning(state) {
  state.hadReasoningSinceContinue = true;
  state.sawReasoning = true;
}
function noteToolActivity(state) {
  state.hadToolActivitySinceContinue = true;
  state.sawToolActivity = true;
}
function noteProxyActivity(state) {
  state.hadProxyActivitySinceContinue = true;
  state.sawProxyActivity = true;
}
function resetAutoContinueWindow(state) {
  state.visibleTextSinceContinue = "";
  state.lastVisibleTextSinceContinue = "";
  state.hadReasoningSinceContinue = false;
  state.hadToolActivitySinceContinue = false;
  state.hadProxyActivitySinceContinue = false;
  state.lastStopReason = null;
}
function runAutoContinue(state, msg) {
  const autoDecision = shouldAutoContinueIncompleteTurn(
    state.autoContinueState,
    {
      text: state.visibleTextSinceContinue,
      lastVisibleText: state.lastVisibleTextSinceContinue,
      hadReasoning: state.hadReasoningSinceContinue,
      hadToolActivity: state.hadToolActivitySinceContinue,
      hadProxyActivity: state.hadProxyActivitySinceContinue,
      isError: msg.is_error,
      stopReason: state.lastStopReason
    }
  );
  if (autoDecision.continue) {
    const signature = continuationSignature({
      text: state.visibleTextSinceContinue,
      lastVisibleText: state.lastVisibleTextSinceContinue,
      hadReasoning: state.hadReasoningSinceContinue,
      hadToolActivity: state.hadToolActivitySinceContinue,
      hadProxyActivity: state.hadProxyActivitySinceContinue,
      isError: msg.is_error
    });
    state.autoContinueState.noProgressCount = signature === state.autoContinueState.lastSignature ? state.autoContinueState.noProgressCount + 1 : 0;
    state.autoContinueState.lastSignature = signature;
    state.autoContinueState.attempts++;
    log.notice("auto-continuing incomplete claude result", {
      sessionKey: state.sessionKey,
      reason: autoDecision.reason,
      attempts: state.autoContinueState.attempts,
      textLength: state.visibleTextSinceContinue.length,
      lastTextLength: state.lastVisibleTextSinceContinue.length,
      hadReasoning: state.hadReasoningSinceContinue,
      hadToolActivity: state.hadToolActivitySinceContinue,
      hadProxyActivity: state.hadProxyActivitySinceContinue
    });
    state.turnCompleted = false;
    resetAutoContinueWindow(state);
    if (state.activeProcess) noteTurnStarted(state.activeProcess);
    state.proc.stdin?.write(makeAutoContinueMessage() + "\n");
    return true;
  }
  log.notice("auto-continuation stopped", {
    sessionKey: state.sessionKey,
    reason: autoDecision.reason,
    stopReason: state.lastStopReason,
    attempts: state.autoContinueState.attempts,
    textLength: state.visibleTextSinceContinue.length,
    lastTextLength: state.lastVisibleTextSinceContinue.length,
    hadReasoning: state.hadReasoningSinceContinue,
    hadToolActivity: state.hadToolActivitySinceContinue,
    hadProxyActivity: state.hadProxyActivitySinceContinue
  });
  return false;
}

// src/stream-parser.ts
var KNOWN_DELTA_TYPES = /* @__PURE__ */ new Set([
  "thinking_delta",
  "text_delta",
  "input_json_delta",
  "signature_delta"
]);
var PROXY_RESULT_BOUNDARY_GRACE_MS = 250;
function createLineHandler(state, ctx) {
  return (line) => {
    if (!line.trim()) return;
    if (state.controllerClosed) return;
    startResultFallback(state);
    try {
      const outer = JSON.parse(line);
      const msg = outer.type === "stream_event" && outer.event ? { ...outer.event, session_id: outer.session_id } : outer;
      const modelProgress = msg.type === "assistant" && !!msg.message?.content?.length || msg.type === "content_block_start" && msg.content_block?.type === "tool_use" || msg.type === "content_block_delta" && (msg.delta?.type === "text_delta" && !!msg.delta.text || msg.delta?.type === "thinking_delta" && !!msg.delta.thinking);
      if (modelProgress) {
        state.hasReceivedProgress = true;
        clearStartWatchdog(state);
        startResultFallback(state);
      }
      if (ctx.attempt && !ctx.attempt.serving && provesModelServing(msg)) {
        ctx.attempt.serving = true;
      }
      if (ctx.modelFallbackArmed && !state.modelRefusal) {
        state.modelRefusal = modelRefusalFromAssistant(msg);
      }
      if (outer.type === "stream_event") {
        state.gotPartialEvents = true;
      }
      if (ctx.handleControlRequest(msg, state.proc)) {
        return;
      }
      log.debug("stream message", {
        type: msg.type,
        subtype: msg.subtype
      });
      if (msg.type === "system" && msg.subtype === "init") {
        if (msg.session_id) {
          setClaudeSessionId(state.sessionKey, msg.session_id);
          log.info("session initialized", {
            claudeSessionId: msg.session_id
          });
        }
        reportFastModeState(msg, ctx.fastMode);
        reportSystemInit(msg, {
          ignoreAnthropicApiKey: ctx.config.ignoreAnthropicApiKey
        });
      }
      if (msg.type === "system" && msg.subtype === "compact_boundary") {
        const note = reportCompactBoundary(msg);
        if (note) {
          state.controller.enqueue({ type: "text-delta", id: state.startTextBlock(), delta: note });
          state.endTextBlock();
        }
      }
      if (msg.type === "conversation_reset") {
        const note = reportConversationReset(msg);
        if (note) {
          state.toolCallMap.clear();
          state.reasoningIds.clear();
          state.reasoningStarted.clear();
          state.textBlockIndices.clear();
          state.controller.enqueue({ type: "text-delta", id: state.startTextBlock(), delta: note });
          state.endTextBlock();
        }
        return;
      }
      const block = accountBlockKind(msg);
      if (block) state.accountBlock = block;
      if (msg.type === "rate_limit_event") {
        const info = parseRateLimitEvent(msg);
        if (info && isRateLimitRejected(info)) {
          state.accountLimitHit = {
            resetsAt: info.resetsAt ?? info.overageResetsAt,
            window: info.rateLimitType
          };
        }
        const note = reportRateLimitEvent(msg);
        if (note) {
          state.controller.enqueue({ type: "text-delta", id: state.startTextBlock(), delta: note });
          state.endTextBlock();
        }
        return;
      }
      if (msg.type === "content_block_start" && msg.content_block && msg.index !== void 0) {
        const block2 = msg.content_block;
        const idx = msg.index;
        if (block2.type === "thinking") {
          noteReasoning(state);
          const reasoningId = generateId2();
          state.reasoningIds.set(idx, reasoningId);
        }
        if (block2.type === "text") {
          state.textBlockIndices.add(idx);
          resetLastVisibleTextBlock(state);
          if (block2.text) {
            if (!state.currentTextId) state.startTextBlock();
            state.controller.enqueue({
              type: "text-delta",
              id: state.currentTextId,
              delta: block2.text
            });
            noteVisibleText(state, block2.text);
            state.hasReceivedContent = true;
          }
        }
        if (block2.type === "tool_use" && block2.id && block2.name) {
          noteToolActivity(state);
          const entry = {
            id: block2.id,
            name: block2.name,
            inputJson: "",
            started: false
          };
          state.toolCallMap.set(idx, entry);
          if (block2.name !== "AskUserQuestion" && block2.name !== "ask_user_question" && block2.name !== "ExitPlanMode" && !block2.name.startsWith(PROXY_TOOL_PREFIX)) {
            const { name: mappedName, skip, executed } = mapTool(
              block2.name,
              void 0,
              {
                webSearch: ctx.config.webSearch,
                sessionId: getClaudeSessionId(state.sessionKey),
                toolUseId: block2.id
              }
            );
            if (!skip) {
              entry.started = true;
              state.controller.enqueue({
                type: "tool-input-start",
                id: block2.id,
                toolName: mappedName,
                providerExecuted: executed
              });
              log.info("tool started", {
                name: block2.name,
                mappedName,
                id: block2.id
              });
            }
          }
        }
      }
      if (msg.type === "content_block_delta" && msg.delta && msg.index !== void 0) {
        const delta = msg.delta;
        const idx = msg.index;
        if (delta.type === "thinking_delta" && delta.thinking) {
          noteReasoning(state);
          state.hadThinkingTextFromStream = true;
          const reasoningId = state.reasoningIds.get(idx);
          if (reasoningId) {
            if (!state.reasoningStarted.get(idx)) {
              state.controller.enqueue({
                type: "reasoning-start",
                id: reasoningId
              });
              state.reasoningStarted.set(idx, true);
            }
            state.controller.enqueue({
              type: "reasoning-delta",
              id: reasoningId,
              delta: delta.thinking
            });
          }
        }
        if (delta.type === "text_delta" && delta.text) {
          if (!state.currentTextId) state.startTextBlock();
          state.controller.enqueue({
            type: "text-delta",
            id: state.currentTextId,
            delta: delta.text
          });
          noteVisibleText(state, delta.text);
          state.hasReceivedContent = true;
        }
        if (delta.type === "input_json_delta" && delta.partial_json) {
          const tc = state.toolCallMap.get(idx);
          if (tc) {
            tc.inputJson += delta.partial_json;
            if (tc.started) {
              state.controller.enqueue({
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
        const reasoningId = state.reasoningIds.get(idx);
        if (reasoningId && state.reasoningStarted.get(idx)) {
          state.controller.enqueue({
            type: "reasoning-end",
            id: reasoningId
          });
          state.reasoningStarted.delete(idx);
        }
        if (state.textBlockIndices.has(idx)) {
          state.endTextBlock();
          state.textBlockIndices.delete(idx);
        }
        const tc = state.toolCallMap.get(idx);
        if (tc) {
          state.toolCallMap.delete(idx);
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(tc.inputJson || "{}");
          } catch {
          }
          if (isAskUserQuestionTool(tc.name)) {
            state.autoContinueState.sawAskUserQuestion = true;
            const askId = state.startTextBlock();
            state.controller.enqueue({
              type: "text-delta",
              id: askId,
              delta: formatAskUserQuestion(parsedInput)
            });
            state.endTextBlock();
          } else if (tc.name === "ExitPlanMode") {
            const plan = parsedInput?.plan || "";
            if (ctx.planModeQuestionActive) {
              const questionCall = createExitPlanModeQuestionCall(
                state.sessionKey,
                tc.id,
                plan
              );
              const planId2 = state.startTextBlock();
              state.controller.enqueue({
                type: "text-delta",
                id: planId2,
                delta: questionCall.text
              });
              finishWithQuestionCall(state, questionCall);
              return;
            }
            const planId = state.startTextBlock();
            state.controller.enqueue({
              type: "text-delta",
              id: planId,
              delta: `

${plan}

---
**Do you want to proceed with this plan?** (yes/no)
`
            });
            state.endTextBlock();
          } else if (isWebSearchTool(tc.name) && isWebSearchHandledByCli(ctx.config.webSearch)) {
            const query = typeof parsedInput?.query === "string" ? parsedInput.query : JSON.stringify(parsedInput);
            const searchId = state.startTextBlock();
            state.controller.enqueue({
              type: "text-delta",
              id: searchId,
              delta: `
> **Web search:** ${query}
`
            });
            state.endTextBlock();
          } else if (tc.name.startsWith(PROXY_TOOL_PREFIX)) {
            noteProxyActivity(state);
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
              webSearch: ctx.config.webSearch,
              sessionId: getClaudeSessionId(state.sessionKey),
              toolUseId: tc.id
            });
            if (!skip) {
              state.toolCallsById.set(tc.id, {
                id: tc.id,
                name: mappedName,
                input: parsedInput
              });
              if (!executed) state.skipResultForIds.add(tc.id);
              state.controller.enqueue({
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
      if (state.gotPartialEvents && msg.type === "message_delta" && typeof msg.delta?.stop_reason === "string") {
        state.lastStopReason = msg.delta.stop_reason;
      }
      if (msg.type === "assistant" && msg.message && typeof msg.message.stop_reason === "string") {
        state.lastStopReason = msg.message.stop_reason;
      }
      const callUsage = msg.type === "assistant" ? msg.message?.usage : void 0;
      if (callUsage && (callUsage.input_tokens ?? 0) + (callUsage.cache_read_input_tokens ?? 0) + (callUsage.cache_creation_input_tokens ?? 0) > 0) {
        state.lastCallUsage = callUsage;
      }
      if (msg.type === "assistant" && msg.message?.content && state.gotPartialEvents) {
        const thinkingBlocks = msg.message.content.filter(
          (b) => b.type === "thinking"
        );
        if (thinkingBlocks.length > 0) {
          log.info("assistant message thinking blocks", {
            count: thinkingBlocks.length,
            hasText: thinkingBlocks.some(
              (b) => typeof b.thinking === "string" && b.thinking.length > 0
            ),
            hadStreamThinking: state.hadThinkingTextFromStream
          });
          if (!state.hadThinkingTextFromStream) {
            for (const block2 of thinkingBlocks) {
              if (block2.thinking && block2.thinking.length > 0) {
                noteReasoning(state);
                state.hadThinkingTextFromStream = true;
                const thinkingId = generateId2();
                state.controller.enqueue({
                  type: "reasoning-start",
                  id: thinkingId
                });
                state.controller.enqueue({
                  type: "reasoning-delta",
                  id: thinkingId,
                  delta: block2.thinking
                });
                state.controller.enqueue({
                  type: "reasoning-end",
                  id: thinkingId
                });
              }
            }
          }
        }
      }
      if (msg.type === "assistant" && msg.message?.content && !state.gotPartialEvents) {
        const hasText = msg.message.content.some(
          (b) => b.type === "text" && b.text
        );
        const hasToolUse = msg.message.content.some(
          (b) => b.type === "tool_use"
        );
        if (hasText) {
          state.hasReceivedContent = true;
        }
        if (hasText && !hasToolUse) {
          startResultFallback(state);
        }
        if (hasToolUse) {
          clearFallbackTimer(state);
        }
        for (const block2 of msg.message.content) {
          if (block2.type === "text" && block2.text) {
            resetLastVisibleTextBlock(state);
            const blockId = state.startTextBlock();
            state.controller.enqueue({
              type: "text-delta",
              id: blockId,
              delta: block2.text
            });
            state.endTextBlock();
            noteVisibleText(state, block2.text);
            state.hasReceivedContent = true;
          }
          if (block2.type === "thinking" && block2.thinking) {
            noteReasoning(state);
            const thinkingId = generateId2();
            state.controller.enqueue({
              type: "reasoning-start",
              id: thinkingId
            });
            state.controller.enqueue({
              type: "reasoning-delta",
              id: thinkingId,
              delta: block2.thinking
            });
            state.controller.enqueue({
              type: "reasoning-end",
              id: thinkingId
            });
          }
          if (block2.type === "tool_use" && block2.id && block2.name) {
            noteToolActivity(state);
            const parsedInput = block2.input ?? {};
            if (isAskUserQuestionTool(block2.name)) {
              const askId = state.startTextBlock();
              state.controller.enqueue({
                type: "text-delta",
                id: askId,
                delta: formatAskUserQuestion(parsedInput)
              });
              state.endTextBlock();
            } else if (block2.name === "ExitPlanMode") {
              const plan = parsedInput?.plan || "";
              if (ctx.planModeQuestionActive) {
                const questionCall = createExitPlanModeQuestionCall(
                  state.sessionKey,
                  block2.id,
                  plan
                );
                const planId2 = state.startTextBlock();
                state.controller.enqueue({
                  type: "text-delta",
                  id: planId2,
                  delta: questionCall.text
                });
                finishWithQuestionCall(state, questionCall);
                return;
              }
              const planId = state.startTextBlock();
              state.controller.enqueue({
                type: "text-delta",
                id: planId,
                delta: `

${plan}

---
**Do you want to proceed with this plan?** (yes/no)
`
              });
              state.endTextBlock();
            } else if (isWebSearchTool(block2.name) && isWebSearchHandledByCli(ctx.config.webSearch)) {
              state.toolCallsById.delete(block2.id);
              const query = typeof parsedInput?.query === "string" ? parsedInput.query : JSON.stringify(parsedInput);
              const searchId = state.startTextBlock();
              state.controller.enqueue({
                type: "text-delta",
                id: searchId,
                delta: `
> **Web search:** ${query}
`
              });
              state.endTextBlock();
            } else if (block2.name.startsWith(PROXY_TOOL_PREFIX)) {
              noteProxyActivity(state);
              log.debug("ignoring proxy tool_use from assistant message", {
                name: block2.name,
                id: block2.id
              });
            } else {
              const {
                name: mappedName,
                input: mappedInput,
                executed,
                skip
              } = mapTool(block2.name, parsedInput, {
                webSearch: ctx.config.webSearch,
                sessionId: getClaudeSessionId(state.sessionKey),
                toolUseId: block2.id
              });
              if (!skip) {
                state.toolCallsById.set(block2.id, {
                  id: block2.id,
                  name: mappedName,
                  input: parsedInput
                });
                if (!executed) state.skipResultForIds.add(block2.id);
                state.controller.enqueue({
                  type: "tool-input-start",
                  id: block2.id,
                  toolName: mappedName,
                  providerExecuted: executed
                });
                state.controller.enqueue({
                  type: "tool-call",
                  toolCallId: block2.id,
                  toolName: mappedName,
                  input: JSON.stringify(mappedInput),
                  providerExecuted: executed
                });
              }
              log.info("tool_use from assistant message", {
                name: block2.name,
                mappedName,
                id: block2.id,
                executed
              });
            }
          }
          if (block2.type === "tool_result") {
            log.debug("tool_result", {
              toolUseId: block2.tool_use_id
            });
          }
        }
      }
      if (msg.type === "user" && msg.message?.content) {
        for (const block2 of msg.message.content) {
          if (block2.type === "tool_result" && block2.tool_use_id) {
            if (state.skipResultForIds.has(block2.tool_use_id)) {
              log.debug("skipping tool-result (opencode runs it)", {
                toolUseId: block2.tool_use_id
              });
              continue;
            }
            let resultText = "";
            if (typeof block2.content === "string") {
              resultText = block2.content;
            } else if (Array.isArray(block2.content)) {
              resultText = block2.content.filter(
                (c) => c.type === "text" && typeof c.text === "string"
              ).map((c) => c.text).join("\n");
            }
            const claudeSessionId = getClaudeSessionId(state.sessionKey);
            if (claudeSessionId) {
              const list2 = applyTaskCreateToolResult(
                claudeSessionId,
                block2.tool_use_id,
                resultText
              );
              if (list2) {
                const synthId = `todowrite_${block2.tool_use_id}`;
                state.controller.enqueue({
                  type: "tool-input-start",
                  id: synthId,
                  toolName: "todowrite",
                  providerExecuted: false
                });
                state.controller.enqueue({
                  type: "tool-call",
                  toolCallId: synthId,
                  toolName: "todowrite",
                  input: JSON.stringify({
                    todos: list2.map((t) => ({
                      id: t.id,
                      content: t.content,
                      status: t.status,
                      priority: "medium"
                    }))
                  }),
                  providerExecuted: false
                });
                noteToolActivity(state);
              }
            }
            const toolCall = state.toolCallsById.get(block2.tool_use_id);
            if (toolCall) {
              const isError = block2.is_error === true;
              state.controller.enqueue({
                type: "tool-result",
                toolCallId: block2.tool_use_id,
                toolName: toolCall.name,
                result: {
                  output: resultText,
                  title: toolCall.name,
                  metadata: isError ? { error: true } : {}
                },
                ...isError ? { isError: true } : {},
                providerExecuted: true
              });
              noteToolActivity(state);
              log.info("tool result emitted", {
                toolUseId: block2.tool_use_id,
                name: toolCall.name,
                isError
              });
              state.toolCallsById.delete(block2.tool_use_id);
            }
          }
        }
      }
      if (msg.type === "result") {
        clearFallbackTimer(state);
        if (msg.session_id) {
          setClaudeSessionId(state.sessionKey, msg.session_id);
        }
        if (deliverPendingCompletions(state)) {
          return;
        }
        if (!state.currentTextId && msg.is_error && typeof msg.result === "string" && msg.result.trim().length > 0) {
          const errId = state.startTextBlock();
          state.controller.enqueue({
            type: "text-delta",
            id: errId,
            delta: msg.result
          });
        }
        if (!state.accountLimitHit && msg.is_error && isAccountLimitError({
          resultText: typeof msg.result === "string" ? msg.result : null
        })) {
          state.accountLimitHit = {};
        }
        if (ctx.modelFallbackArmed && !state.modelRefusal) {
          state.modelRefusal = modelRefusalFromResult(msg);
        }
        if (state.accountBlock && msg.is_error) {
          state.resultFailure ??= state.accountBlock;
          const offeringSwitch = ctx.failoverAskActive;
          state.controller.enqueue({
            type: "text-delta",
            id: state.startTextBlock(),
            delta: formatAccountBlockNote({
              kind: state.accountBlock,
              account: ctx.sourceAccount,
              configDir: ctx.config.configDir,
              offeringSwitch
            })
          });
          state.endTextBlock();
          log.warn(`Claude account "${ctx.sourceAccount}" cannot serve requests`, {
            sessionKey: state.sessionKey,
            kind: state.accountBlock,
            offeringSwitch
          });
        }
        const failure = describeResultFailure(msg);
        if (failure) {
          state.resultFailure = msg.subtype;
          state.controller.enqueue({
            type: "text-delta",
            id: state.startTextBlock(),
            delta: formatResultFailureNote(failure)
          });
          log.warn(failure, { sessionKey: state.sessionKey, subtype: msg.subtype });
        }
        const turnStats = extractTurnStats(msg);
        state.resultMeta = {
          sessionId: msg.session_id,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          durationApiMs: msg.duration_api_ms,
          numTurns: msg.num_turns,
          usage: msg.usage,
          modelUsage: msg.modelUsage,
          // Names and ids only: a denial's `tool_input` can be a whole
          // file write payload and has no business in metadata.
          permissionDenials: msg.permission_denials?.map((denial) => ({
            tool_name: denial.tool_name,
            tool_use_id: denial.tool_use_id
          }))
        };
        log.info("conversation result", {
          sessionId: msg.session_id,
          numTurns: msg.num_turns,
          isError: msg.is_error,
          subtype: msg.subtype,
          ...turnStatsLogPayload(turnStats)
        });
        if (ctx.config.turnStats && !ctx.compactionMode && !msg.is_error && !failure) {
          const footer = formatTurnStatsBlock(turnStats);
          if (footer) {
            state.controller.enqueue({
              type: "text-delta",
              id: state.startTextBlock(),
              delta: footer
            });
          }
        }
        state.turnCompleted = true;
        state.endTextBlock();
        const shouldDeferResult = !msg.is_error && !state.autoContinueState.aborted && !state.autoContinueState.sawAskUserQuestion;
        if (state.drainBuffer.length > 0 && shouldDeferResult) {
          log.info(
            "waiting for parallel proxy calls at turn-result boundary",
            {
              sessionKey: state.sessionKey,
              count: state.drainBuffer.length
            }
          );
          scheduleResultBoundary(
            state,
            () => ctx.completeResult(msg),
            DRAIN_QUIET_MS
          );
          return;
        }
        if (state.drainBuffer.length === 0 && state.hadProxyActivitySinceContinue && shouldDeferResult) {
          log.info(
            "waiting for delayed proxy call at turn-result boundary",
            {
              sessionKey: state.sessionKey,
              graceMs: PROXY_RESULT_BOUNDARY_GRACE_MS
            }
          );
          scheduleResultBoundary(
            state,
            () => ctx.completeResult(msg),
            PROXY_RESULT_BOUNDARY_GRACE_MS
          );
          return;
        }
        ctx.completeResult(msg);
      }
    } catch (e) {
      log.debug("failed to parse line", {
        error: e instanceof Error ? e.message : String(e)
      });
    }
  };
}

// src/claude-code-language-model.ts
async function isProxyCallStillServed(callId) {
  const pending = findPendingProxyCall(callId);
  if (!pending || pending.emitted !== true) return false;
  const session = describeSessionKey(pending.sessionKey).session;
  return await fetchSessionRunState(session) === "busy";
}
setProxyDeadlineGuard(({ callId }) => isProxyCallStillServed(callId));
var CHILD_EXIT_STATUS_GRACE_MS = 250;
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
    return toUsage(rawUsage);
  }
  toFinishReason(reason = "stop") {
    return toFinishReason(reason);
  }
  /**
   * Whether this call only names the session, which gets the synthetic stub
   * rather than a `claude` spawn. See `isTitleRequest` in title.ts.
   */
  isTitleRequest(scope, options) {
    return isTitleRequest(this.config, scope, options);
  }
  requestScope(options) {
    return requestScope(options);
  }
  /**
   * Build the combined `--mcp-config` list and return both the list and the
   * hash of the bridged opencode MCP block. See `effectiveMcpConfig` in
   * spawn-planning.ts.
   */
  effectiveMcpConfig(cwd, proxyConfigPath, runtimeStatus, excludeServers) {
    return effectiveMcpConfig(
      this.config,
      cwd,
      proxyConfigPath,
      runtimeStatus,
      excludeServers
    );
  }
  /** Resolve ProxyToolDef[] for the configured proxyTools names. */
  resolvedProxyTools() {
    return resolvedProxyTools(this.config);
  }
  /** Resolve ProxyToolDef[] for opencode's MCP-backed tools. */
  resolvedProxyMcpTools(allEnabledServerNames, modelTools, taken) {
    return resolvedProxyMcpTools(
      this.config,
      allEnabledServerNames,
      modelTools,
      taken
    );
  }
  /** One `client.tool.list()` fetch, shaped for this turn's gates. */
  async fetchLiveToolInfo() {
    return fetchLiveToolInfo(this.config, this.modelId);
  }
  /**
   * Whether dcp-style context reminders should be stripped from this turn's
   * messages. Config-only and synchronous, so it can be answered before the
   * spawn block resolves anything: `userMsg` is built well ahead of it.
   */
  stripContextRemindersEnabled() {
    return stripContextRemindersEnabled(this.config);
  }
  /**
   * Arguments the skill bridge needs beyond `cwd` / `cliPath`: which
   * `CLAUDE_CONFIG_DIR` this spawn reads its native skills from, and whether
   * to drop the ones it already loads.
   */
  skillBridgeSpawn(failover) {
    return skillBridgeSpawn(this.config, failover);
  }
  /** Share one lazy registry request within a turn without making it stale. */
  createLiveToolInfoLoader() {
    return createLiveToolInfoLoader(this.config, this.modelId);
  }
  /**
   * Whether the ExitPlanMode approval bridge is live for this turn: the
   * operator opted in AND opencode's registry actually has the `question`
   * tool. Without the registry entry the emitted tool-call would render as
   * `⚙ invalid` and wedge the turn, so the plugin keeps the text path.
   */
  async resolvePlanModeQuestion(compactionMode, loadLiveToolInfo = () => this.fetchLiveToolInfo()) {
    return resolvePlanModeQuestion(this.config, compactionMode, loadLiveToolInfo);
  }
  /**
   * Create a proxy MCP server for a single active Claude process/session.
   * The process lifecycle owns the server lifecycle via session-manager.
   */
  async ensureProxyServer(tools, sessionKeyForCalls, interceptCompress) {
    return ensureProxyServer(
      this.config,
      tools,
      sessionKeyForCalls,
      interceptCompress
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
    return controlRequestBehaviorForTool(this.config, toolName);
  }
  writeControlResponse(proc, requestId, response) {
    writeControlResponse(proc, requestId, response);
  }
  /**
   * Handle Claude stream-json control requests (`can_use_tool`, etc.) and
   * respond via stdin with a matching `control_response`.
   */
  handleControlRequest(msg, proc) {
    return handleControlRequest(this.config, msg, proc);
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
  getOpencodeAgent(options) {
    return resolveOpencodeAgent(
      options?.headers,
      options.providerOptions,
      this.config.provider
    );
  }
  isCompactionCall(options) {
    return this.getOpencodeAgent(options) === "compaction";
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
    return latestUserText(prompt);
  }
  synthesizeTitle(prompt) {
    return synthesizeTitle(prompt);
  }
  /**
   * Aggregates the one turn implementation into a `doGenerate` result.
   *
   * `doGenerate` used to carry a second copy of `doStreamForHost`'s line
   * parser: no inactivity watchdog, no `/claude-code-doctor`, no proxy or MCP
   * wiring, no auto-continue, no turn stats, and no test of its own. Three of
   * its own branches (a `/btw` aside, proxied tools, compaction) already bailed
   * out to this method. The copy is deleted and every `doGenerate` call is now
   * this aggregation, so a fix to the turn lands once.
   *
   * Tool parts arrive already in the host's vocabulary, because `streamTurn`
   * rewrites them once at the stream's edge (src/host-tools.ts). Nothing is
   * translated a second time here.
   */
  async doGenerateViaStream(options) {
    log.info("doGenerate aggregating the stream", {
      scope: this.requestScope(options),
      opencodeAgent: this.getOpencodeAgent(options)
    });
    const result = await this.streamTurn(options, "generate");
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
    const sessionId = providerMetadata?.["claude-code"]?.sessionId;
    return {
      content,
      finishReason,
      usage,
      request: result.request,
      response: {
        id: typeof sessionId === "string" && sessionId ? sessionId : generateId3(),
        timestamp: /* @__PURE__ */ new Date(),
        modelId: this.modelId
      },
      providerMetadata,
      warnings: []
    };
  }
  /**
   * One turn implementation serves both host methods, so this is `doStream`
   * aggregated. The host's tool vocabulary is applied inside `streamTurn`,
   * which is why nothing is renamed here.
   */
  async doGenerate(options) {
    return this.doGenerateViaStream(options);
  }
  /**
   * Tool parts leave in opencode 1.x's vocabulary; on opencode 2.x they are
   * renamed at this one edge (src/host-tools.ts). On V1 the stream is
   * returned untouched.
   */
  async doStream(options) {
    return this.streamTurn(options, "stream");
  }
  /**
   * The turn, for both host methods. `mode` is documented on `TurnMode`; it is
   * threaded down to `doStreamForHost` rather than read from the call options,
   * because which method opencode used is not in them.
   */
  async streamTurn(options, mode) {
    const result = await this.runModelChain(options, mode);
    return {
      ...result,
      stream: translateStreamForHost(result.stream, this.config.hostApi ?? "v1")
    };
  }
  /**
   * Run the turn, moving to the next model in the fallback chain if the one
   * it started on is refused. The single wiring point for `src/model-fallback.ts`.
   *
   * With no chain declared (the default) this is `doStreamForHost` and one
   * `await`, so nothing about an existing install changes. With a chain, one
   * rule carries the whole design: **an attempt's parts are withheld until it
   * proves the model is serving**, and a refused attempt is then discarded
   * whole rather than edited. That is what keeps the CLI's "There's an issue
   * with the selected model" text out of the operator's transcript and out of
   * any replay, and it costs nothing on a served turn, because the very first
   * content block commits the attempt and every later part passes straight
   * through.
   *
   * The bound is `tried`: one turn spawns each model at most once, in order,
   * and an exhausted chain leaves the last attempt un-armed so its error
   * surfaces exactly as it does today.
   */
  async runModelChain(options, mode) {
    const agent = this.getOpencodeAgent(options);
    const chain = this.isCompactionCall(options) ? [] : resolveFallbackChain(agent, resolveAgentModel(agent, this.modelId));
    if (chain.length === 0) return this.doStreamForHost(options, void 0, mode);
    const self = this;
    const tried = /* @__PURE__ */ new Set();
    let attempt = { armed: true };
    let inner = await this.doStreamForHost(options, attempt, mode);
    const request = inner.request;
    const stream = new ReadableStream({
      async start(controller) {
        let pendingNote = null;
        try {
          for (; ; ) {
            if (attempt.modelId) tried.add(attempt.modelId);
            const buffered = [];
            let flushed = false;
            const emitNote = (note) => {
              const id = generateId3();
              controller.enqueue({ type: "text-start", id });
              controller.enqueue({ type: "text-delta", id, delta: note });
              controller.enqueue({ type: "text-end", id });
            };
            const flush = () => {
              if (flushed) return;
              flushed = true;
              for (const part of buffered) {
                controller.enqueue(part);
                if (pendingNote && part.type === "stream-start") {
                  emitNote(pendingNote);
                  pendingNote = null;
                }
              }
              buffered.length = 0;
              if (pendingNote) {
                emitNote(pendingNote);
                pendingNote = null;
              }
            };
            const reader = inner.stream.getReader();
            try {
              for (; ; ) {
                const { done, value } = await reader.read();
                if (done) break;
                if (flushed) {
                  controller.enqueue(value);
                  continue;
                }
                buffered.push(value);
                if (attempt.serving) flush();
              }
            } finally {
              reader.releaseLock();
            }
            const refusal = attempt.refusal;
            const next = refusal && !attempt.serving ? nextFallbackModel(chain, tried) : void 0;
            if (!next || !refusal) {
              flush();
              break;
            }
            buffered.length = 0;
            pendingNote = formatModelFallbackNote({
              failed: attempt.modelId ?? self.modelId,
              serving: next,
              refusal
            });
            log.notice("falling back to the next model in the chain", {
              from: attempt.modelId ?? self.modelId,
              to: next,
              reason: refusal.kind,
              tried: [...tried]
            });
            tried.add(next);
            attempt = {
              modelOverride: next,
              armed: nextFallbackModel(chain, tried) !== void 0
            };
            inner = await self.doStreamForHost(options, attempt, mode);
          }
        } catch (error) {
          controller.enqueue({ type: "error", error });
        } finally {
          try {
            controller.close();
          } catch {
          }
        }
      }
    });
    return { stream, request };
  }
  async doStreamForHost(options, attempt, mode = "stream") {
    const warnings = [];
    const skipPermissions = this.config.skipPermissions !== false;
    const scope = this.requestScope(options);
    const affinity = this.sessionAffinity(options);
    const cwd = await resolveSpawnCwdForSession(this.config.cwd, affinity);
    const compactionMode = this.isCompactionCall(options);
    const effectiveModelId = compactionMode ? this.resolveCompactionModel() : attempt?.modelOverride ?? resolveAgentModel(
      this.getOpencodeAgent(options),
      this.modelId
    );
    if (attempt) attempt.modelId = effectiveModelId;
    const reasoningEffort = compactionMode ? void 0 : resolveAgentEffort(
      this.getOpencodeAgent(options),
      this.getReasoningEffort(options.providerOptions)
    );
    const promptCacheTtl = compactionMode ? void 0 : resolveAgentCacheTtl(this.getOpencodeAgent(options));
    const context = [
      this.config.provider,
      this.getOpencodeAgent(options) ?? null
    ];
    if (promptCacheTtl) context.push(promptCacheTtl);
    const baseKey = sessionKey(
      cwd,
      `${effectiveModelId}::${scope}::${affinity}::context=${JSON.stringify(context)}`
    );
    const sk = compactionMode ? sessionKey(cwd, `${effectiveModelId}::compaction::${affinity}`) : effortSessionKey(baseKey, reasoningEffort);
    const toUsage2 = this.toUsage.bind(this);
    const toFinishReason2 = this.toFinishReason.bind(this);
    const handleControlRequest2 = this.handleControlRequest.bind(this);
    const flagOn = (v) => v !== void 0 && !["", "0", "false", "no", "off"].includes(v.trim().toLowerCase());
    const interactivePref = this.config.interactive ?? flagOn(process.env.CLAUDE_CODE_INTERACTIVE_TRANSPORT);
    const useInteractive = interactivePref && typeof globalThis.Bun?.Terminal === "function";
    const interactiveBypassRequested = this.config.interactiveBypass ?? flagOn(process.env.CLAUDE_CODE_INTERACTIVE_BYPASS);
    const modelFallbackArmed = attempt?.armed === true && !compactionMode && !useInteractive;
    const sourceAccount = normalizeAccountName(
      this.config.account ?? DEFAULT_ACCOUNT
    );
    const baseCliPath = this.config.baseCliPath ?? this.config.cliPath;
    let failover = useInteractive || compactionMode ? { cliPath: this.config.cliPath, modelId: effectiveModelId, failedOver: false } : await resolveFailoverSpawn({
      account: sourceAccount,
      baseCliPath,
      cliPath: this.config.cliPath,
      modelId: effectiveModelId
    });
    let cliPath = failover.cliPath;
    const asideTransportRef = { cliPath, interactive: !!useInteractive };
    const doctor = !compactionMode && scope !== "no-tools" ? parseDoctorCommand(options.prompt) : null;
    if (doctor) {
      const doctorOptions = {
        cliPath,
        interactive: !!useInteractive,
        turnStats: this.config.turnStats === true,
        ignoreAnthropicApiKey: this.config.ignoreAnthropicApiKey === true,
        // `/claude-code-doctor usage` opts into the CLI's own plan-usage
        // report; anything else here is ignored, as it always has been.
        argument: doctor.rest
      };
      const stream2 = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
          try {
            const text = await buildDoctorReport(doctorOptions);
            const id = generateId3();
            controller.enqueue({ type: "text-start", id });
            controller.enqueue({ type: "text-delta", id, delta: text });
            controller.enqueue({ type: "text-end", id });
            controller.enqueue({
              type: "finish",
              finishReason: toFinishReason2("stop"),
              usage: toUsage2({ input_tokens: 0, output_tokens: 0 }),
              providerMetadata: {
                "claude-code": { path: "doctor", synthetic: true, usageUnavailable: true }
              }
            });
          } catch (error) {
            controller.enqueue({ type: "error", error });
          } finally {
            controller.close();
          }
        }
      });
      return { stream: stream2, request: { body: { text: `/${DOCTOR_COMMAND}` } } };
    }
    const aside = !compactionMode && scope !== "no-tools" ? parseSideQuestion(options.prompt) : null;
    if (aside) {
      const active = getActiveProcess(sk);
      const early = aside.question ? takeSideQuestionAnswer(affinity, aside.question) : void 0;
      const history = collectSideQuestionHistory(options.prompt);
      const answerAside = async () => {
        if (!aside.question) return { response: SIDE_QUESTION_USAGE, synthetic: true };
        if (early) {
          try {
            return await early;
          } catch (error) {
            log.info("btw: early answer failed, asking the idle process", { error: String(error) });
          }
        }
        if (!active) return { response: BTW_NO_SESSION_MESSAGE, synthetic: true };
        return requestSideQuestion(active, aside.question, {
          cliVersion: await detectCliVersion(cliPath),
          interactive: useInteractive,
          abortSignal: options.abortSignal,
          ...history.length ? { history } : {}
        });
      };
      const stream2 = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
          try {
            const answer = await answerAside();
            const id = generateId3();
            controller.enqueue({ type: "text-start", id });
            controller.enqueue({ type: "text-delta", id, delta: answer.response });
            controller.enqueue({ type: "text-end", id });
            controller.enqueue({
              type: "finish",
              finishReason: toFinishReason2("stop"),
              usage: toUsage2({}),
              providerMetadata: { "claude-code": { path: "side-question", synthetic: answer.synthetic, usageUnavailable: true } }
            });
          } catch (error) {
            controller.enqueue({ type: "error", error });
          } finally {
            controller.close();
          }
        }
      });
      return { stream: stream2, request: { body: { text: aside.question } } };
    }
    if (this.isTitleRequest(scope, options) && !compactionMode) {
      log.info("doStream no-tools title stub", {
        compactionMode,
        opencodeAgent: this.getOpencodeAgent(options),
        providerOptionsKeys: options.providerOptions ? Object.keys(options.providerOptions) : []
      });
      const text = this.synthesizeTitle(options.prompt);
      const textId = generateId3();
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
            finishReason: toFinishReason2("stop"),
            usage: toUsage2({ input_tokens: 0, output_tokens: 0 }),
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
            finishReason: toFinishReason2("stop"),
            usage: toUsage2({ input_tokens: 0, output_tokens: 0 }),
            providerMetadata: {
              "claude-code": { synthetic: true, path: "no-new-user-content" }
            }
          });
          controller.close();
        }
      });
      return { stream: stream2, request: { body: { text: "" } } };
    }
    if (!compactionMode) invalidateOtherEffortSessions(baseKey, reasoningEffort);
    const hasPriorConversation = options.prompt.filter((m) => m.role === "user" || m.role === "assistant").length > 1;
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk);
      deleteActiveProcess(sk);
      clearCompression(sk);
    }
    const failoverAnswer = compactionMode || useInteractive || mode === "generate" ? null : consumeAccountFailoverAnswer(sk, options.prompt, {
      sourceAccount,
      candidates: failoverCandidates(this.config.failoverAccounts, sourceAccount)
    });
    if (failoverAnswer?.kind === "stop") {
      log.warn("account failover declined; ending the turn", {
        sessionKey: sk,
        account: sourceAccount,
        reason: failoverAnswer.reason
      });
      const note = formatFailoverStopNote(failoverAnswer.reason);
      const stream2 = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
          const id = generateId3();
          controller.enqueue({ type: "text-start", id });
          controller.enqueue({ type: "text-delta", id, delta: note });
          controller.enqueue({ type: "text-end", id });
          controller.enqueue({
            type: "error",
            error: new Error(
              `Claude account "${sourceAccount}" is out of usage and no other account was picked.`
            )
          });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "error", raw: "account_limit" },
            usage: toUsage2({ input_tokens: 0, output_tokens: 0 }),
            providerMetadata: {
              "claude-code": {
                path: "account-failover-stop",
                synthetic: true,
                usageUnavailable: true
              }
            }
          });
          controller.close();
        }
      });
      return { stream: stream2, request: { body: { text: "" } } };
    }
    let failoverNote = null;
    if (failoverAnswer?.kind === "switch") {
      setAccountOverride(
        failoverAnswer.sourceAccount,
        failoverAnswer.target,
        failoverUntil(failoverAnswer.resetsAt)
      );
      failover = await resolveFailoverSpawn({
        account: sourceAccount,
        baseCliPath,
        cliPath: this.config.cliPath,
        modelId: effectiveModelId
      });
      cliPath = failover.cliPath;
      asideTransportRef.cliPath = cliPath;
      failoverNote = formatFailoverNote({
        sourceAccount: failoverAnswer.sourceAccount,
        target: failoverAnswer.target,
        resetsAt: failoverAnswer.resetsAt
      });
    }
    const processForAccount = getActiveProcess(sk);
    if (!compactionMode && !useInteractive && processForAccount?.cliPath && processForAccount.cliPath !== cliPath) {
      log.notice("claude process belongs to another account; starting fresh", {
        sessionKey: sk,
        was: processForAccount.cliPath,
        now: cliPath,
        failedOver: failover.failedOver
      });
      deleteActiveProcess(sk);
      deleteClaudeSessionId(sk);
    }
    const hasExistingSession = !!getClaudeSessionId(sk);
    const hasActiveProcess = !!getActiveProcess(sk);
    let includeHistoryContext = !hasExistingSession && !hasActiveProcess && hasPriorConversation;
    if (failoverAnswer?.kind === "switch" && hasPriorConversation) {
      includeHistoryContext = true;
    }
    const { model: spawnModelId, fast: fastMode } = parseModelId(failover.modelId);
    const exitPlanModeQuestionResult = compactionMode ? null : consumeExitPlanModeQuestionResult(sk, options.prompt);
    if (exitPlanModeQuestionResult) {
      log.info("sending plan approval decision to claude", { sk });
    }
    const previousPendingProxyCalls = compactionMode ? [] : getPendingProxyCalls(sk);
    const effectivePrompt = failoverAnswer?.kind === "switch" ? buildFailoverContinuationPrompt(options.prompt, failoverAnswer.target) : options.prompt;
    const userMsg = exitPlanModeQuestionResult ?? getClaudeUserMessage(effectivePrompt, includeHistoryContext, {
      compactionMode,
      cliToolCallIds: new Set(previousPendingProxyCalls.map((c) => c.toolCallId)),
      stripContextReminders: this.stripContextRemindersEnabled()
    });
    const resolvedProxy = compactionMode ? null : this.resolvedProxyTools();
    const loadLiveToolInfo = this.createLiveToolInfoLoader();
    const planModeQuestionActive = await this.resolvePlanModeQuestion(
      compactionMode,
      loadLiveToolInfo
    );
    const self = this;
    const previousPendingProxyMatches = previousPendingProxyCalls.map((call) => ({
      call,
      result: extractPendingProxyResultForCall(options.prompt, call)
    }));
    const hasMatchedPendingResults = previousPendingProxyMatches.some(
      (m) => m.result !== null
    );
    const [runtimeStatus, cliVersion] = await Promise.all([
      compactionMode ? Promise.resolve(void 0) : getRuntimeMcpStatus(),
      detectCliVersion(cliPath)
    ]);
    const failoverAccounts = failoverCandidates(
      this.config.failoverAccounts,
      sourceAccount
    );
    const failoverAskActive = failoverAccounts.length > 0 && this.config.accountFailover !== "off" && !compactionMode && !useInteractive && // A `doGenerate` caller takes the override and reports the plain
    // rate-limit error, never the form. See `TurnMode`.
    mode !== "generate" && isAccountFailoverQuestionActive({
      configured: this.config.accountFailover,
      candidates: failoverAccounts,
      opencodeHasQuestion: (await loadLiveToolInfo()).hasQuestion,
      compactionMode,
      interactive: !!useInteractive,
      // A subagent follows its parent's account for free, because the
      // override is account-scoped. Asking it would put a form in a session
      // the operator is usually not even looking at.
      childSession: !!await fetchSessionParentId(affinity)
    });
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
      opencodeAgent: this.getOpencodeAgent(options),
      providerOptionsKeys: options.providerOptions ? Object.keys(options.providerOptions) : []
    });
    const stream = new ReadableStream({
      start(controller) {
        if (compactionMode) {
          deleteActiveProcess(sk);
          deleteClaudeSessionId(sk);
        }
        if (!compactionMode && !hasMatchedPendingResults && consumeCompressionRestart(sk)) {
          deleteActiveProcess(sk);
          deleteClaudeSessionId(sk);
          log.info("compress reset: dropped claude process and session id", {
            sessionKey: sk
          });
        }
        const state = createTurnState({
          controller,
          sessionKey: sk,
          cwd,
          cliPath,
          ignoreAnthropicApiKey: self.config.ignoreAnthropicApiKey,
          userMsg,
          autoContinueEnabled: autoContinueEnabledFor(
            compactionMode,
            self.config.autoContinueIncompleteTurns
          ),
          toUsage: toUsage2,
          toFinishReason: toFinishReason2
        });
        state.activeProcess = getActiveProcess(sk);
        state.proxyServer = state.activeProcess?.proxyServer ?? null;
        const setup = async () => {
          if (!compactionMode && state.activeProcess && self.config.hotReloadMcp !== false && self.config.bridgeOpencodeMcp !== false) {
            const probe = self.effectiveMcpConfig(cwd, void 0, runtimeStatus);
            const previousHash = state.activeProcess.mcpHash ?? null;
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
                state.activeProcess = void 0;
                state.proxyServer = null;
              }
            }
          }
          if (useInteractive && !compactionMode) {
            const mcp = self.effectiveMcpConfig(cwd, void 0, runtimeStatus);
            if (state.activeProcess) {
              state.proc = state.activeProcess.proc;
              state.lineEmitter = state.activeProcess.lineEmitter;
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
                self.config.multiStepContinuation !== false
                // Do not forward opencode's own system prompt into the
                // interactive TUI. Live subscription-account testing
                // showed that large forwarded payload can trigger Claude
                // Code's third-party-app usage gate, while our static
                // CLI/AGENTS/continuation prompt remains safe.
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
              const skillPluginDirs = await resolveSkillPluginDirs({
                cwd,
                cliPath,
                enabled: self.config.bridgeOpencodeSkills === true,
                ...self.skillBridgeSpawn(failover)
              });
              const ap = spawnInteractiveProcess({
                cwd,
                cliPath,
                configDir: self.config.configDir,
                model: spawnModelId,
                fastMode,
                mcpConfigPaths: mcp.paths,
                pluginDirs: skillPluginDirs,
                permissionsAllow: allow,
                systemPromptFile,
                ignoreAnthropicApiKey: self.config.ignoreAnthropicApiKey,
                effort: reasoningEffort
              });
              ap.mcpHash = mcp.bridgedHash;
              setActiveProcess(sk, ap);
              state.proc = ap.proc;
              state.lineEmitter = ap.lineEmitter;
              state.activeProcess = ap;
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
              state.cliArgs = buildCliArgs({
                sessionKey: sk,
                skipPermissions,
                includeSessionId: false,
                model: spawnModelId,
                permissionMode: self.config.permissionMode,
                fastMode,
                cliVersion
              });
            } else {
              const discovery = self.effectiveMcpConfig(
                cwd,
                void 0,
                runtimeStatus
              );
              const mcpResolution = self.resolvedProxyMcpTools(
                discovery.allEnabledServerNames,
                options.tools,
                new Set((resolvedProxy ?? []).map((def) => def.name))
              );
              const proxyMcpTools = mcpResolution?.defs ?? null;
              const excludeServers = mcpResolution ? mcpResolution.coveredServers : void 0;
              const taskProxyEnabled = resolvedProxy?.some((t) => t.name === "task") ?? false;
              const questionProxyEnabled = resolvedProxy?.some((t) => t.name === "question") ?? false;
              const opencodeToolsRequested = (self.config.proxyOpencodeTools?.length ?? 0) > 0;
              log.debug("opencode tool forwarding gate", {
                requested: self.config.proxyOpencodeTools ?? null,
                opencodeToolsRequested
              });
              const liveToolInfo = taskProxyEnabled || questionProxyEnabled || opencodeToolsRequested ? await loadLiveToolInfo() : {
                resolved: false,
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
              const opencodeToolDefs = resolveProxyOpencodeToolDefs({
                requested: self.config.proxyOpencodeTools,
                items: liveToolInfo.items,
                taken: new Set(
                  [...enrichedProxy ?? [], ...proxyMcpTools ?? []].map(
                    (t) => t.name
                  )
                )
              });
              if (opencodeToolDefs.length > 0) {
                log.info("forwarding opencode tools through the proxy", {
                  tools: opencodeToolDefs.map((t) => t.name)
                });
              }
              const combinedList = [
                ...enrichedProxy ?? [],
                ...proxyMcpTools ?? [],
                ...opencodeToolDefs
              ];
              const combinedProxyTools = combinedList.length > 0 ? combinedList : null;
              const pluginCompressEnabled = enrichedProxy?.some((t) => t.name === "compress") ?? false;
              if (!state.proxyServer && combinedProxyTools) {
                state.proxyServer = await self.ensureProxyServer(
                  combinedProxyTools,
                  sk,
                  pluginCompressEnabled
                );
              }
              const questionProxyActive = enrichedProxy?.some((t) => t.name === "question") ?? false;
              const allDisallowed = resolveDisallowedTools({
                proxyTools: enrichedProxy,
                extraDisallowedTools: self.config.extraDisallowedTools,
                disableWebSearch: self.config.webSearch === "disabled"
              });
              const mcp = self.effectiveMcpConfig(
                cwd,
                state.proxyServer?.configPath(),
                runtimeStatus,
                excludeServers
              );
              const systemPromptFile = state.activeProcess ? void 0 : buildAppendedSystemPrompt(
                cwd,
                self.config.multiStepContinuation !== false,
                [
                  ...extractSystemMessages(options.prompt),
                  ...taskProxyEnabled ? [SUBAGENT_DISPATCH_HINT] : [],
                  ...questionProxyActive ? [QUESTION_PROXY_HINT] : []
                ],
                {
                  compressEnabled: pluginCompressEnabled,
                  opencodeCompressEnabled: opencodeToolDefs.some(
                    (t) => t.name === "compress"
                  ),
                  compressionSummary: getCompressionSummary(sk)
                }
              );
              const skillPluginDirs = await resolveSkillPluginDirs({
                cwd,
                cliPath,
                enabled: self.config.bridgeOpencodeSkills === true,
                ...self.skillBridgeSpawn(failover)
              });
              state.cliArgs = buildCliArgs({
                sessionKey: sk,
                skipPermissions,
                model: spawnModelId,
                permissionMode: self.config.permissionMode,
                mcpConfig: mcp.paths,
                strictMcpConfig: self.config.strictMcpConfig,
                disallowedTools: allDisallowed.length > 0 ? allDisallowed : void 0,
                appendSystemPromptFile: systemPromptFile,
                pluginDirs: skillPluginDirs,
                ...self.thinkingCliOptions(),
                fastMode,
                cliVersion
              });
              spawnSystemPromptFile = systemPromptFile;
              spawnProxyServer = state.proxyServer;
              spawnMcpHash = mcp.bridgedHash;
            }
            if (state.activeProcess && !compactionMode) {
              state.proc = state.activeProcess.proc;
              state.lineEmitter = state.activeProcess.lineEmitter;
              log.debug("reusing active process", { sk });
            } else {
              const ap = spawnClaudeProcess(
                cliPath,
                state.cliArgs,
                cwd,
                sk,
                spawnProxyServer,
                spawnMcpHash,
                spawnSystemPromptFile,
                self.config.ignoreAnthropicApiKey,
                reasoningEffort,
                promptCacheTtl
              );
              state.proc = ap.proc;
              state.lineEmitter = ap.lineEmitter;
              state.activeProcess = ap;
            }
          }
          if (state.activeProcess && !hasMatchedPendingResults && isTurnInFlight(state.activeProcess)) {
            log.warn("previous turn still in flight; interrupting it", { sk });
            const idle = await interruptTurn(state.activeProcess);
            if (!idle) {
              log.warn("previous turn did not stop in time; this turn may see stale output", { sk });
            }
          }
          controller.enqueue({ type: "stream-start", warnings });
          if (failoverNote) {
            controller.enqueue({
              type: "text-delta",
              id: state.startTextBlock(),
              delta: failoverNote
            });
            state.endTextBlock();
          }
          state.autoContinueState.startedAt = Date.now();
          const completeResult = (msg) => {
            if (state.controllerClosed) return;
            if (deliverPendingCompletions(state)) {
              if (state.drainBuffer.length > 0) drainNow(state);
              return;
            }
            if (state.drainBuffer.length > 0) {
              drainNow(state);
              return;
            }
            const pendingSiblings = getPendingProxyCalls(sk);
            if (pendingSiblings.length > 0) {
              log.info("leaving parallel proxy calls pending at result boundary", {
                sessionKey: sk,
                count: pendingSiblings.length
              });
            }
            state.activeProcess?.pendingProxyCompletions?.clear();
            if ((state.accountLimitHit || state.accountBlock) && failoverAskActive && msg.is_error === true) {
              const call = createAccountFailoverQuestionCall(sk, {
                sourceAccount,
                candidates: failoverAccounts,
                resetsAt: state.accountLimitHit?.resetsAt,
                window: state.accountLimitHit?.window,
                reason: state.accountLimitHit || !state.accountBlock ? void 0 : describeAccountBlock(state.accountBlock)
              });
              log.warn(
                `Claude account "${sourceAccount}" ${state.accountLimitHit || !state.accountBlock ? "is out of usage" : `cannot serve (${state.accountBlock})`}; asking which account to continue on.`,
                {
                  sessionKey: sk,
                  candidates: failoverAccounts,
                  toolCallId: call.toolCallId,
                  resetsAt: state.accountLimitHit?.resetsAt ?? null
                }
              );
              finishWithQuestionCall(state, call);
              return;
            }
            if (modelFallbackArmed && attempt && msg.is_error === true) {
              const refusal = state.modelRefusal ?? (state.accountLimitHit && !failoverAskActive && !state.accountBlock ? { kind: "account_limit" } : null);
              if (refusal) {
                attempt.refusal = refusal;
                log.warn(
                  `Claude will not serve "${effectiveModelId}" (${refusal.kind}); falling back to the next model in the chain.`,
                  { sessionKey: sk, model: effectiveModelId, detail: refusal.detail ?? null }
                );
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "error", raw: refusal.kind },
                  usage: toUsage2(lastCallContextUsage(state.lastCallUsage, msg.usage)),
                  providerMetadata: {
                    "claude-code": { ...state.resultMeta, path: "model-fallback" }
                  }
                });
                state.controllerClosed = true;
                cleanupTurn();
                deleteActiveProcess(sk);
                deleteClaudeSessionId(sk);
                try {
                  controller.close();
                } catch {
                }
                return;
              }
            }
            if (runAutoContinue(state, msg)) return;
            for (const [idx, reasoningId] of state.reasoningIds) {
              if (state.reasoningStarted.get(idx)) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: reasoningId
                });
              }
            }
            if (isSilentTurn({
              enabled: state.autoContinueState.enabled,
              compactionMode,
              sawVisibleText: state.sawVisibleText,
              sawToolActivity: state.sawToolActivity,
              sawProxyActivity: state.sawProxyActivity,
              isError: msg.is_error === true || state.resultFailure !== void 0,
              aborted: state.autoContinueState.aborted,
              sawQuestion: state.autoContinueState.sawAskUserQuestion
            })) {
              log.notice("claude finished the turn without a reply", {
                sessionKey: sk,
                stopReason: state.lastStopReason,
                hadReasoning: state.sawReasoning,
                attempts: state.autoContinueState.attempts
              });
              controller.enqueue({
                type: "text-delta",
                id: state.startTextBlock(),
                delta: formatSilentTurnNote(state.sawReasoning)
              });
              state.endTextBlock();
            }
            const usage = toUsage2(lastCallContextUsage(state.lastCallUsage, msg.usage));
            controller.enqueue({
              type: "finish",
              finishReason: state.resultFailure ? { unified: "error", raw: state.resultFailure } : toFinishReason2("stop"),
              usage,
              providerMetadata: {
                "claude-code": {
                  ...state.resultMeta,
                  ...state.resultFailure ? { resultSubtype: state.resultFailure } : {},
                  ...compactionMode ? { compactionModel: effectiveModelId } : {}
                },
                // opencode falls back to this when the usage has no cache
                // write (0 is sent as none), so it must match the usage, never
                // the turn total.
                ...typeof msg.usage?.cache_creation_input_tokens === "number" ? {
                  anthropic: {
                    cacheCreationInputTokens: usage.inputTokens.cacheWrite ?? 0
                  }
                } : {}
              }
            });
            state.controllerClosed = true;
            cleanupTurn();
            if (!useInteractive && !compactionMode) {
              scheduleIdleProcessEviction(
                sk,
                resolveIdleProcessTimeoutMs(self.config.idleProcessTimeoutMs)
              );
            }
            try {
              controller.close();
            } catch {
            }
          };
          const lineHandler = createLineHandler(state, {
            config: self.config,
            compactionMode,
            fastMode,
            planModeQuestionActive,
            sourceAccount,
            failoverAskActive,
            modelFallbackArmed,
            attempt,
            handleControlRequest: handleControlRequest2,
            completeResult
          });
          const closeHandler = () => {
            log.debug("readline closed");
            if (state.controllerClosed) return;
            if (state.drainBuffer.length > 0 || getPendingProxyCalls(sk).length > 0) {
              rejectAllPendingProxyCallsForSession(
                sk,
                new Error(
                  "Claude CLI subprocess closed before pending tool calls were resolved"
                )
              );
              state.drainBuffer.length = 0;
            }
            const crashed = !state.turnCompleted && !state.autoContinueState.aborted;
            state.controllerClosed = true;
            cleanupTurn();
            state.endTextBlock();
            const finishClose = (exitCode, signal) => {
              if (crashed) {
                log.warn("claude process closed without a result", {
                  sessionKey: sk,
                  exitCode,
                  signal,
                  stderrBytes: state.activeProcess?.lastStderr?.length ?? 0
                });
                controller.enqueue({
                  type: "error",
                  error: new Error(
                    describeChildCrash(exitCode, signal, state.activeProcess?.lastStderr)
                  )
                });
              }
              controller.enqueue({
                type: "finish",
                finishReason: toFinishReason2(crashed ? "error" : "stop"),
                usage: toUsage2(),
                providerMetadata: {
                  "claude-code": {
                    ...state.resultMeta,
                    ...compactionMode ? { compactionModel: effectiveModelId } : {}
                  }
                }
              });
              try {
                controller.close();
              } catch {
              }
            };
            if (crashed && state.proc.exitCode === null && state.proc.signalCode === null) {
              let reported = false;
              const report = (exitCode, signal) => {
                if (reported) return;
                reported = true;
                clearTimeout(exitGrace);
                state.proc.off("exit", onExit);
                finishClose(exitCode, signal);
              };
              const onExit = (code, signal) => report(code, signal);
              const exitGrace = setTimeout(
                () => report(state.proc.exitCode, state.proc.signalCode),
                CHILD_EXIT_STATUS_GRACE_MS
              );
              state.proc.once("exit", onExit);
              return;
            }
            finishClose(state.proc.exitCode, state.proc.signalCode);
          };
          const cleanupTurn = () => {
            if (state.cleanedUp) return;
            state.cleanedUp = true;
            clearFallbackTimer(state);
            state.pendingResultCompletion = null;
            clearStartWatchdog(state);
            if (state.drainTimer) {
              clearTimeout(state.drainTimer);
              state.drainTimer = null;
            }
            state.lineEmitter.off("line", lineHandler);
            state.lineEmitter.off("close", closeHandler);
            state.pendingProxyUnsubscribe?.();
            state.pendingProxyUnsubscribe = null;
            state.asideSinkUnregister?.();
            state.asideSinkUnregister = null;
            state.proc.off("error", procErrorHandler);
          };
          const procErrorHandler = (err) => {
            log.error("process error", { error: err.message });
            deleteActiveProcess(sk);
            deleteClaudeSessionId(sk);
            if (state.controllerClosed) return;
            if (state.drainBuffer.length > 0 || getPendingProxyCalls(sk).length > 0) {
              rejectAllPendingProxyCallsForSession(
                sk,
                new Error(
                  `Claude CLI subprocess error: ${err.message}`
                )
              );
              state.drainBuffer.length = 0;
            }
            state.controllerClosed = true;
            cleanupTurn();
            controller.enqueue({ type: "error", error: err });
            try {
              controller.close();
            } catch {
            }
          };
          state.lineHandler = lineHandler;
          state.closeHandler = closeHandler;
          state.procErrorHandler = procErrorHandler;
          state.cleanupTurn = cleanupTurn;
          if (state.activeProcess) {
            const unattended = takeUnattendedLines(state.activeProcess);
            if (unattended.lines.length > 0 || unattended.dropped > 0) {
              log.notice("replaying stdout the child emitted between turns", {
                sessionKey: sk,
                lines: unattended.lines.length,
                dropped: unattended.dropped
              });
              let partialText = false;
              {
                if (unattended.dropped > 0) {
                  const id = state.startTextBlock();
                  controller.enqueue({
                    type: "text-delta",
                    id,
                    delta: `> _${unattended.dropped} lines of output emitted between turns were dropped._

`
                  });
                }
                for (const line of unattended.lines) {
                  try {
                    const outer = JSON.parse(line);
                    const msg = outer.type === "stream_event" && outer.event ? outer.event : outer;
                    let text = "";
                    if (msg.type === "content_block_delta" && msg.delta?.type === "text_delta") {
                      text = msg.delta.text ?? "";
                      partialText = true;
                    } else if (msg.type === "assistant") {
                      if (!partialText) text = (msg.message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
                      partialText = false;
                    } else if (msg.type === "result") {
                      state.unattendedTurnEnded = true;
                      for (const entry of state.activeProcess.pendingProxyCompletions?.values() ?? []) {
                        if (isPendingProxyCallChannelClosed(entry.call)) entry.recoveryRequired = true;
                      }
                      if (outer.session_id) setClaudeSessionId(sk, outer.session_id);
                      if (msg.is_error && msg.result) text = msg.result;
                    }
                    if (text) controller.enqueue({ type: "text-delta", id: state.currentTextId ?? state.startTextBlock(), delta: text });
                  } catch {
                  }
                }
              }
              state.endTextBlock();
              clearFallbackTimer(state);
              state.hasReceivedContent = false;
            }
          }
          if (state.activeProcess && !compactionMode) {
            state.activeProcess.opencodeSessionID = affinity;
            state.activeProcess.asideTransport = asideTransportRef;
          }
          if (!compactionMode) {
            state.asideSinkUnregister = registerAsideSink(affinity, (text) => {
              if (state.controllerClosed) return false;
              const asideId = state.startTextBlock();
              controller.enqueue({ type: "text-delta", id: asideId, delta: text });
              state.endTextBlock();
              return true;
            });
          }
          state.lineEmitter.on("line", lineHandler);
          state.lineEmitter.on("close", closeHandler);
          state.pendingProxyUnsubscribe = onPendingProxyCall(sk, (call) => {
            if (state.controllerClosed) {
              log.warn(
                "pending proxy call arrived after stream close; rejecting",
                {
                  sessionKey: sk,
                  toolCallId: call.toolCallId,
                  toolName: call.toolName
                }
              );
              rejectPendingProxyCallById(
                call.toolCallId,
                new Error(
                  `Pending proxy call '${call.toolName}' arrived after the stream was already closed`
                )
              );
              return;
            }
            log.info("received pending proxy call for session", {
              sessionKey: sk,
              toolCallId: call.toolCallId,
              toolName: call.toolName
            });
            noteProxyActivity(state);
            noteToolActivity(state);
            state.drainBuffer.push(call);
            if (noteResultBoundaryCall(state)) return;
            if (state.drainTimer) clearTimeout(state.drainTimer);
            state.drainTimer = setTimeout(() => drainNow(state), DRAIN_QUIET_MS);
          });
          state.proc.on("error", procErrorHandler);
          if (options.abortSignal) {
            const releaseAbandonedProxyCalls = (reason) => {
              if (state.drainBuffer.length === 0 && getPendingProxyCalls(sk).length === 0) return;
              rejectAllPendingProxyCallsForSession(sk, new Error(reason));
              state.drainBuffer.length = 0;
            };
            options.abortSignal.addEventListener("abort", () => {
              state.autoContinueState.aborted = true;
              if (state.turnCompleted || state.controllerClosed) {
                const stoppedProcess = state.activeProcess;
                if (stoppedProcess && stoppedProcess.lineEmitter.listenerCount("line") === 0 && getPendingProxyCalls(sk).length > 0) {
                  const reason = describeAbortReason(options.abortSignal?.reason);
                  void settleSessionRunState(affinity).then((stopped) => {
                    const stillParked = stoppedProcess.lineEmitter.listenerCount("line") === 0 && getPendingProxyCalls(sk).length > 0;
                    if (stopped === "busy" || !stillParked) {
                      log.debug("abort at a tool boundary while opencode is still running the turn; keeping pending calls", {
                        sk,
                        session: stopped,
                        stillParked,
                        reason
                      });
                      return;
                    }
                    log.info("abort between proxy tool boundaries; releasing pending calls", { sk, reason });
                    void interruptTurn(stoppedProcess).then((idle) => {
                      log.info("interrupt sent for aborted turn", { sk, idle });
                    });
                    releaseAbandonedProxyCalls(
                      "Provider stream was aborted while opencode was running its proxy tool calls"
                    );
                  });
                }
                return;
              }
              if (state.activeProcess) {
                void interruptTurn(state.activeProcess).then((idle) => {
                  log.info("interrupt sent for aborted turn", { sk, idle });
                });
              }
              if (!state.hasReceivedContent) {
                log.info(
                  "abort signal received before content, closing stream immediately",
                  { cwd }
                );
                releaseAbandonedProxyCalls(
                  "Provider stream was aborted before pending proxy calls were emitted"
                );
                state.controllerClosed = true;
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
              releaseAbandonedProxyCalls(
                "Provider stream was aborted while proxy tool calls were pending"
              );
              startResultFallback(state, 5e3);
            });
          }
          if (hasMatchedPendingResults) {
            for (const { call, result } of previousPendingProxyMatches) {
              if (result) {
                const channelClosed = isPendingProxyCallChannelClosed(call);
                log.info("resolving pending proxy call from tool result prompt", {
                  sessionKey: sk,
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                  channelClosed
                });
                const completions = state.activeProcess.pendingProxyCompletions ??= /* @__PURE__ */ new Map();
                if (!completions.has(call.toolCallId)) {
                  completions.set(call.toolCallId, {
                    call,
                    result,
                    recoveryRequired: channelClosed || state.unattendedTurnEnded
                  });
                }
                resolvePendingProxyCallById(call.toolCallId, result);
              } else {
                log.info(
                  "leaving unmatched parallel proxy call pending",
                  {
                    sessionKey: sk,
                    toolCallId: call.toolCallId,
                    toolName: call.toolName
                  }
                );
              }
            }
            if (state.unattendedTurnEnded) deliverPendingCompletions(state);
            const unemitted = getPendingProxyCalls(sk).filter(
              (call) => !call.emitted
            );
            if (unemitted.length > 0) {
              log.notice("draining proxy calls queued between turns", {
                sessionKey: sk,
                toolCallIds: unemitted.map((call) => call.toolCallId)
              });
              state.drainBuffer.push(...unemitted);
              drainNow(state);
              return;
            }
            if (getPendingProxyCalls(sk).length === 0) {
              armStartWatchdog(state);
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
          if (state.activeProcess) noteTurnStarted(state.activeProcess);
          state.proc.stdin?.write(userMsg + "\n");
          log.debug("sent user message", { textLength: userMsg.length });
          armStartWatchdog(state);
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

// src/cleanup-stale.ts
import {
  existsSync as existsSync3,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync6,
  realpathSync as realpathSync2,
  rmSync as rmSync3,
  writeFileSync as writeFileSync5
} from "fs";
import { homedir as homedir7 } from "os";
import { dirname as dirname6, join as join9, resolve as resolve5 } from "path";
import { fileURLToPath as fileURLToPath3 } from "url";
var STALE_PACKAGE_NAME = "opencode-claude-code-plugin";
var SUSPECT_DESCRIPTION_TOKEN = "Claude Code";
var alreadyRan = false;
function candidateCacheRoots() {
  const xdg = process.env.XDG_CACHE_HOME;
  return [
    xdg ? join9(xdg, "opencode") : null,
    join9(homedir7(), ".cache", "opencode"),
    join9(homedir7(), "Library", "Caches", "opencode")
  ].filter((p) => Boolean(p));
}
function userOpencodeJsonPath() {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join9(homedir7(), ".config");
  return join9(xdgConfig, "opencode", "opencode.json");
}
function userIntendsToUseUnscoped() {
  const cfg = userOpencodeJsonPath();
  if (!existsSync3(cfg)) return false;
  try {
    const json = JSON.parse(readFileSync6(cfg, "utf8"));
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
    const filePath = fileURLToPath3(import.meta.url);
    return realpathSync2(resolve5(filePath, "..", ".."));
  } catch {
    return null;
  }
}
function ourVersion(dir) {
  if (!dir) return null;
  try {
    const pkg = JSON.parse(readFileSync6(join9(dir, "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}
function markerPath() {
  const stateRoot = process.env.XDG_STATE_HOME ?? join9(homedir7(), ".local", "state");
  return join9(stateRoot, "opencode-claude-code-plugin", "cleanup-stale.json");
}
function markerVersion() {
  try {
    const marker = JSON.parse(readFileSync6(markerPath(), "utf8"));
    return typeof marker.version === "string" ? marker.version : null;
  } catch {
    return null;
  }
}
function writeMarker(version) {
  const file = markerPath();
  try {
    mkdirSync4(dirname6(file), { recursive: true });
    writeFileSync5(
      file,
      JSON.stringify({ version, at: (/* @__PURE__ */ new Date()).toISOString() }, null, 2) + "\n",
      "utf8"
    );
  } catch (err) {
    log.warn("cleanup-stale: could not record the sweep marker", {
      file,
      error: String(err)
    });
  }
}
function cleanupStaleUnscopedInstall() {
  if (alreadyRan) return;
  alreadyRan = true;
  if (process.env.OPENCODE_CLAUDE_CODE_PLUGIN_NO_CLEANUP === "1") return;
  if (userIntendsToUseUnscoped()) return;
  const ourDir = ourLoadedDir();
  const version = ourVersion(ourDir);
  const forced = process.env.OPENCODE_CLAUDE_CODE_PLUGIN_FORCE_CLEANUP === "1";
  if (version && !forced && markerVersion() === version) return;
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
  if (version) writeMarker(version);
}
function cleanupOne(cacheRoot, ourDir) {
  if (!existsSync3(cacheRoot)) return;
  const stalePath = join9(cacheRoot, "node_modules", STALE_PACKAGE_NAME);
  if (!existsSync3(stalePath)) return;
  let realStalePath = stalePath;
  try {
    realStalePath = realpathSync2(stalePath);
  } catch {
  }
  if (ourDir && realStalePath === ourDir) return;
  const pkgJsonPath = join9(stalePath, "package.json");
  if (!existsSync3(pkgJsonPath)) return;
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync6(pkgJsonPath, "utf8"));
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
  const cachePkgJson = join9(cacheRoot, "package.json");
  if (!existsSync3(cachePkgJson)) return;
  try {
    const cfg = JSON.parse(readFileSync6(cachePkgJson, "utf8"));
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

// src/v2-client.ts
import path9 from "path";
function formatAgentTypeList(agents) {
  const lines = agents.flatMap((agent) => {
    if (agent.hidden === true || agent.mode === "primary") return [];
    const name = typeof agent.id === "string" ? agent.id : agent.name;
    if (typeof name !== "string" || name.length === 0) return [];
    const blurb = typeof agent.description === "string" ? agent.description.trim() : "";
    return [`- ${name}: ${blurb || "(no description)"}`];
  });
  if (lines.length === 0) return void 0;
  return `Available agent types and the tools they have access to:
${lines.join("\n")}`;
}
function describe(value) {
  if (typeof value === "string") return value;
  if (typeof value === "function") {
    try {
      const result = value();
      return typeof result === "string" ? result : "";
    } catch {
      return "";
    }
  }
  return "";
}
function toV1Session(info) {
  if (!info || typeof info !== "object") return void 0;
  const session = info;
  const root = session.location?.directory;
  const directory = typeof root === "string" ? typeof session.subpath === "string" && session.subpath.length > 0 ? path9.resolve(root, session.subpath) : root : void 0;
  return { ...info, directory, parentID: session.parentID };
}
function createV1ClientShim(ctx) {
  const client = {};
  const mcpList = ctx.mcp?.list;
  if (typeof mcpList === "function") {
    client.mcp = {
      // V1: `{ data: { [server]: { status } } }`. V2: `{ data: [{ name, status: { status } }] }`.
      status: async () => {
        const result = await mcpList.call(ctx.mcp);
        const data = {};
        for (const server2 of result?.data ?? []) {
          const status = server2?.status?.status;
          if (typeof server2?.name === "string" && typeof status === "string") {
            data[server2.name] = { status };
          }
        }
        return { data };
      }
    };
  }
  const toolList = ctx.tool?.list;
  if (typeof toolList === "function") {
    client.tool = {
      // V1: `{ data: [{ id, description, parameters }] }`. V2 returns the tools
      // themselves, with an Effect schema for input rather than JSON Schema, so
      // `parameters` is empty; only `proxyOpencodeTools` reads it.
      list: async () => {
        const tools = await toolList.call(ctx.tool);
        const data = (tools ?? []).flatMap((tool) => {
          const id = typeof tool?.id === "string" ? tool.id : tool?.name;
          return typeof id === "string" ? [{ id, description: describe(tool.description), parameters: {} }] : [];
        });
        const subagent = data.find((tool) => tool.id === "subagent");
        if (subagent && !data.some((tool) => tool.id === "task")) {
          let agentList;
          const agentApi = ctx.agent?.list;
          if (typeof agentApi === "function") {
            try {
              agentList = formatAgentTypeList((await agentApi.call(ctx.agent))?.data ?? []);
            } catch {
              agentList = void 0;
            }
          }
          const description = agentList ? `${subagent.description}

${agentList}` : subagent.description;
          data.push({ ...subagent, id: "task", description });
        }
        return { data };
      }
    };
  }
  const sessionGet = ctx.session?.get;
  if (typeof sessionGet === "function") {
    client.session = {
      get: async (options) => ({
        data: toV1Session(await sessionGet.call(ctx.session, { sessionID: options.path.id }))
      })
    };
  }
  return client;
}

// src/v2.ts
var V2_PLUGIN_PACKAGE = "aisdk:@khalilgharbaoui/opencode-claude-code-plugin";
var SESSION_AFFINITY_HEADER = "x-session-affinity";
var OPENCODE_AGENT_HEADER = "x-opencode-agent";
var PLUGIN_ONLY_SETTINGS = ["accounts", "defaultSubagentModel"];
var OPENCODE_SDK_OPTION_KEYS = ["fetch", "headers", "body", "name"];
function isClaudeCodeProviderId(providerID) {
  if (typeof providerID !== "string") return false;
  return providerID === BASE_PROVIDER_ID || providerID.startsWith(`${BASE_PROVIDER_ID}-`);
}
function agentForRequest(kind, agent) {
  if (kind === "compaction") return "compaction";
  if (kind === "title") return "title";
  return agent;
}
function releasedAt(date) {
  const ms = date ? Date.parse(date) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}
function modalities(flags) {
  return Object.entries(flags).filter(([, enabled]) => enabled === true).map(([name]) => name);
}
function toV2Model(model, providerID, modelId) {
  return {
    id: modelId,
    modelID: modelId,
    providerID,
    name: model.name,
    family: model.family,
    capabilities: {
      tools: model.capabilities.toolcall,
      input: modalities(model.capabilities.input),
      output: modalities(model.capabilities.output)
    },
    variants: Object.entries(model.variants ?? {}).map(([id, settings]) => ({
      id,
      settings: { ...settings }
    })),
    time: { released: releasedAt(model.release_date) },
    cost: [
      {
        input: model.cost.input,
        output: model.cost.output,
        cache: { read: model.cost.cache.read, write: model.cost.cache.write }
      }
    ],
    status: model.status ?? "active",
    enabled: true,
    limit: { context: model.limit.context, output: model.limit.output },
    package: V2_PLUGIN_PACKAGE
  };
}
function v2ModelsForProvider(providerID, modelSuffix) {
  return Object.entries(defaultModels).map(
    ([id, model]) => toV2Model(model, providerID, modelSuffix ? `${id}@${modelSuffix}` : id)
  );
}
function stripPluginOnly(settings) {
  const result = { ...settings ?? {} };
  for (const key of PLUGIN_ONLY_SETTINGS) delete result[key];
  return result;
}
function planV2Providers(seedSettings, defaultProxyTools) {
  const base = {
    cliPath: "claude",
    proxyTools: [...defaultProxyTools],
    ...stripPluginOnly(seedSettings)
  };
  const accounts = resolveAccounts(seedSettings?.accounts);
  if (!accounts) {
    return [
      {
        info: {
          id: BASE_PROVIDER_ID,
          name: "Claude Code",
          activation: "enabled",
          package: V2_PLUGIN_PACKAGE,
          settings: { ...base, providerID: BASE_PROVIDER_ID }
        },
        models: v2ModelsForProvider(BASE_PROVIDER_ID)
      }
    ];
  }
  return accounts.map((account) => {
    const providerID = accountProviderId(account);
    return {
      info: {
        id: providerID,
        name: accountDisplayName(account),
        activation: "enabled",
        package: V2_PLUGIN_PACKAGE,
        settings: {
          ...base,
          account,
          // The resolved list, so this account's language model can offer the
          // others when it runs out of usage (src/account-failover.ts).
          failoverAccounts: accounts,
          providerID,
          // Kept separately because the wrapper replaces `cliPath`, and a
          // failover builds another account's wrapper on the same base.
          baseCliPath: String(base.cliPath ?? "claude")
        }
      },
      models: v2ModelsForProvider(providerID, accountModelSuffix(account))
    };
  });
}
async function resolveSdkSettings(providerID, planned, eventOptions) {
  const fromEvent = { ...eventOptions };
  for (const key of OPENCODE_SDK_OPTION_KEYS) delete fromEvent[key];
  const merged = {
    ...stripPluginOnly({ ...planned ?? {}, ...fromEvent }),
    providerID,
    // The only place a model is told it serves opencode 2.
    hostApi: "v2"
  };
  const account = typeof merged.account === "string" ? merged.account : void 0;
  if (account) {
    const base = String(merged.baseCliPath ?? merged.cliPath ?? "claude");
    const runtime = await ensureAccountRuntime(account, base);
    Object.assign(merged, runtime, { baseCliPath: base });
  }
  return merged;
}
function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function configuredSeedSettings(config, pluginOptions) {
  const provider = plainObject(plainObject(config.provider)?.[BASE_PROVIDER_ID]);
  return {
    ...plainObject(provider?.options) ?? {},
    ...plainObject(provider?.settings) ?? {},
    ...pluginOptions ?? {}
  };
}
function isOpencodeV2Context(ctx) {
  const context = plainObject(ctx);
  if (!context) return false;
  const version = plainObject(context.app)?.version;
  if (typeof version === "string") {
    const major = Number.parseInt(version.replace(/^v/, ""), 10);
    if (Number.isFinite(major) && major < 2) return false;
  }
  const hasHook = (domain, name) => typeof plainObject(domain)?.[name] === "function";
  return hasHook(context.provider, "transform") && hasHook(context.aisdk, "hook") && hasHook(context.session, "hook");
}
function commandPromptText(command, args) {
  const rest = (args ?? "").trim();
  return rest ? `/${command} ${rest}` : `/${command}`;
}
function deletedSessionIdV2(event) {
  if (!event || event.type !== "session.deleted") return void 0;
  const id = event.data?.sessionID;
  return typeof id === "string" && id.length > 0 ? id : void 0;
}
async function releaseDeletedSessions(subscribe, signal) {
  try {
    for await (const event of subscribe({ signal })) {
      if (signal.aborted) break;
      const sessionID = deletedSessionIdV2(event);
      if (!sessionID) continue;
      const released = deleteActiveProcessesForSession(sessionID);
      if (released.length > 0) {
        log.info("released claude state for deleted session", { sessionID, released });
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      log.warn("opencode 2 event subscription ended; deleted sessions keep their claude process until idle eviction", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}
function createV2Setup(deps) {
  return async (ctx) => {
    if (!isOpencodeV2Context(ctx)) {
      log.debug("setup called outside opencode 2; leaving it to server()", {
        version: ctx?.app?.version
      });
      return () => void 0;
    }
    ensureProcessExitCleanup();
    setOpencodeClient(createV1ClientShim(ctx));
    const directory = ctx.location?.directory;
    setOpencodeProjectDirectory(isUsableDirectory(directory) ? directory : void 0);
    if (deps.buildAgentRegistry) {
      try {
        const config = deps.loadConfig(directory ?? process.cwd());
        await deps.buildAgentRegistry({
          ...config,
          provider: {
            ...plainObject(config.provider) ?? {},
            [BASE_PROVIDER_ID]: {
              options: configuredSeedSettings(config, plainObject(ctx.options))
            }
          }
        });
      } catch (err) {
        log.warn("failed to build the agent registry for opencode 2", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    const planned = /* @__PURE__ */ new Map();
    const registrations = [];
    registrations.push(
      await ctx.provider.transform((editor) => {
        const seed = editor.get(BASE_PROVIDER_ID);
        const seedSettings = {
          ...seed?.provider.settings ?? {},
          ...configuredSeedSettings(
            deps.loadConfig(directory ?? process.cwd()),
            plainObject(ctx.options)
          )
        };
        const plans = planV2Providers(seedSettings, deps.defaultProxyTools);
        planned.clear();
        for (const plan of plans) {
          planned.set(plan.info.id, plan.info.settings ?? {});
          if (editor.get(plan.info.id)) {
            editor.update(plan.info.id, (provider) => {
              provider.name = plan.info.name;
              provider.activation = plan.info.activation;
              provider.package = plan.info.package;
              provider.settings = plan.info.settings;
            });
            editor.models.set(plan.info.id, plan.models);
          } else {
            editor.add({ info: plan.info, models: plan.models });
          }
        }
        if (seed && !plans.some((plan) => plan.info.id === BASE_PROVIDER_ID)) {
          editor.remove(BASE_PROVIDER_ID);
        }
        logStartupDiagnostics(
          Object.fromEntries(
            plans.map((plan) => [plan.info.id, { name: plan.info.name, options: plan.info.settings }])
          ),
          ctx.app?.version
        );
      })
    );
    registrations.push(
      await ctx.aisdk.hook("sdk", async (event) => {
        const providerID = event.model.providerID;
        if (!isClaudeCodeProviderId(providerID)) return;
        const settings = await resolveSdkSettings(providerID, planned.get(providerID), event.options);
        event.sdk = deps.createProvider(settings);
        log.debug("v2 sdk created", { providerID, cliPath: settings.cliPath });
      })
    );
    registrations.push(
      await ctx.session.hook("model.request", (event) => {
        if (!isClaudeCodeProviderId(event.model.providerID)) return;
        event.headers[SESSION_AFFINITY_HEADER] = event.sessionID;
        event.headers[OPENCODE_AGENT_HEADER] = agentForRequest(event.kind, event.agent);
      })
    );
    const prompt = ctx.session.prompt;
    if (ctx.command?.transform && typeof prompt === "function") {
      const send = (input, command, delivery) => prompt.call(ctx.session, {
        ...input.prompt,
        sessionID: input.sessionID,
        text: commandPromptText(command, input.prompt.text),
        delivery
      }).then(() => void 0);
      registrations.push(
        await ctx.command.transform((editor) => {
          editor.add({
            name: DOCTOR_COMMAND,
            description: DOCTOR_COMMAND_DESCRIPTION,
            execute: (input) => send(input, DOCTOR_COMMAND, input.delivery)
          });
          editor.add({
            name: "btw",
            description: BTW_COMMAND_DESCRIPTION,
            execute: (input) => send(input, "btw", "queue")
          });
        })
      );
    }
    const bundledSkills = readBundledSkillInfos();
    if (typeof ctx.skill?.transform === "function" && bundledSkills.length > 0) {
      registrations.push(
        await ctx.skill.transform((editor) => {
          const added = [];
          for (const skill of bundledSkills) {
            if (editor.get(skill.id)) continue;
            editor.add(skill);
            added.push(skill.id);
          }
          log.debug("v2 bundled skills registered", { added });
        })
      );
    }
    const events = new AbortController();
    if (typeof ctx.event?.subscribe === "function") {
      void releaseDeletedSessions(ctx.event.subscribe.bind(ctx.event), events.signal);
    }
    log.info("claude-code plugin set up for opencode 2", {
      opencode: ctx.app?.version,
      directory
    });
    return async () => {
      events.abort();
      for (const registration of registrations.splice(0)) {
        await registration.dispose().catch(() => void 0);
      }
    };
  };
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
var warnedPlanModeNoExit = false;
function registerSideQuestionCommand(config) {
  config.command ??= {};
  if (config.command.btw) return false;
  config.command.btw = {
    template: "/btw $ARGUMENTS",
    description: BTW_COMMAND_DESCRIPTION
  };
  return true;
}
function registerDoctorCommand(config) {
  config.command ??= {};
  if (config.command[DOCTOR_COMMAND]) return false;
  config.command[DOCTOR_COMMAND] = {
    template: `/${DOCTOR_COMMAND} $ARGUMENTS`,
    description: DOCTOR_COMMAND_DESCRIPTION
  };
  return true;
}
var ownsSideQuestionCommand = false;
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
      "ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN detected; claude may bill as pay-as-you-go API usage instead of your subscription. Set provider option `ignoreAnthropicApiKey: true` to force subscription auth."
    );
  }
}
function _resetPlanModeWarningForTests() {
  warnedPlanModeNoExit = false;
}
function warnIfPlanModeCannotExit(permissionMode) {
  if (permissionMode !== "plan") return;
  if (warnedPlanModeNoExit) return;
  warnedPlanModeNoExit = true;
  log.warn(
    'permissionMode "plan" is enforced: claude cannot edit files or run commands, and --dangerously-skip-permissions is deliberately not passed so it stays that way. Headless Claude Code is not offered an ExitPlanMode tool, so nothing releases plan mode mid-session; approving a plan in chat does not unlock writes. Leaving plan mode means changing the config and restarting opencode.',
    { permissionMode, measuredOn: "claude-code 2.1.258" }
  );
}
function applyPermissionPreset(settings, defaultProxyTools) {
  const resolved = resolvePermissionPreset(settings, defaultProxyTools);
  if (resolved === null) return null;
  if (isUnknownPreset(resolved)) {
    log.warn(
      "unknown permissionPreset; no preset applied and every permission setting is left exactly as configured",
      { permissionPreset: resolved.unknown, known: ["read-only"] }
    );
    return null;
  }
  log.notice(`permission preset "${resolved.preset}" applied`, {
    permissionMode: resolved.permissionMode,
    skipPermissions: resolved.skipPermissions,
    proxyTools: resolved.proxyTools,
    disallowedTools: resolved.extraDisallowedTools,
    controlRequestBehavior: resolved.controlRequestBehavior
  });
  for (const line of resolved.overridden) {
    log.notice(`permission preset "${resolved.preset}" overrode ${line}`);
  }
  return resolved;
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
  const preset = applyPermissionPreset(settings, DEFAULT_PROXY_TOOL_NAMES);
  warnIfPlanModeCannotExit(preset ? void 0 : settings.permissionMode);
  const cliPath = settings.cliPath ?? process.env.CLAUDE_CLI_PATH ?? "claude";
  const providerName = settings.providerID ?? settings.name ?? "claude-code";
  const proxyTools = preset?.proxyTools ?? settings.proxyTools ?? [...DEFAULT_PROXY_TOOL_NAMES];
  const createModel = (modelId) => {
    return new ClaudeCodeLanguageModel(modelId, {
      provider: providerName,
      cliPath,
      hostApi: settings.hostApi,
      cwd: settings.cwd,
      account: settings.account,
      configDir: settings.configDir,
      failoverAccounts: settings.failoverAccounts,
      baseCliPath: settings.baseCliPath ?? cliPath,
      accountFailover: settings.accountFailover ?? "ask",
      providerID: settings.providerID,
      skipPermissions: preset?.skipPermissions ?? settings.skipPermissions ?? true,
      permissionMode: preset?.permissionMode ?? settings.permissionMode,
      permissionPreset: preset?.preset,
      mcpConfig: settings.mcpConfig,
      strictMcpConfig: settings.strictMcpConfig,
      bridgeOpencodeMcp: settings.bridgeOpencodeMcp ?? true,
      controlRequestBehavior: preset?.controlRequestBehavior ?? settings.controlRequestBehavior ?? "allow",
      controlRequestToolBehaviors: preset ? void 0 : settings.controlRequestToolBehaviors,
      controlRequestDenyMessage: settings.controlRequestDenyMessage,
      proxyTools,
      proxyOpencodeTools: settings.proxyOpencodeTools,
      stripContextReminders: settings.stripContextReminders === true,
      extraDisallowedTools: preset?.extraDisallowedTools ?? settings.extraDisallowedTools,
      proxyToolTimeoutMs: settings.proxyToolTimeoutMs,
      planModeQuestion: settings.planModeQuestion ?? false,
      webSearch: settings.webSearch,
      hotReloadMcp: settings.hotReloadMcp ?? true,
      proxyOpencodeMcpTools: settings.proxyOpencodeMcpTools === true,
      multiStepContinuation: settings.multiStepContinuation ?? true,
      autoContinueIncompleteTurns: settings.autoContinueIncompleteTurns ?? "smart",
      compactionModel: settings.compactionModel,
      ignoreAnthropicApiKey: settings.ignoreAnthropicApiKey,
      idleProcessTimeoutMs: settings.idleProcessTimeoutMs,
      bridgeOpencodeSkills: settings.bridgeOpencodeSkills === true,
      bridgeSkipNativeSkills: settings.bridgeSkipNativeSkills !== false,
      turnStats: settings.turnStats === true,
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
  delete result.defaultSubagentModel;
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
      models[id] = completeUserModel(id, model, providerID);
    }
  }
  return models;
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function completeUserModel(id, entry, providerID) {
  const record = isRecord4(entry) ? entry : {};
  const runtimeShaped = isRecord4(record.capabilities) && isRecord4(record.capabilities.input) && isRecord4(record.capabilities.output) && isRecord4(record.cost) && isRecord4(record.cost.cache) && isRecord4(record.api);
  if (runtimeShaped) {
    return toConfigModel({ ...record, providerID });
  }
  const base = toConfigModel({ ...passthroughModel(id), providerID });
  log.warn("provider model entry is partial; completing it from the pass-through template", {
    providerID,
    model: id,
    declared: Object.keys(record)
  });
  const merged = { ...base, ...record, id };
  for (const key of ["cost", "limit", "variants"]) {
    merged[key] = {
      ...isRecord4(base[key]) ? base[key] : {},
      ...isRecord4(record[key]) ? record[key] : {}
    };
  }
  return merged;
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
      ...runtime,
      // The pre-wrapper binary, kept because `runtime` replaces `cliPath`
      // with the account's wrapper and a failover has to build ANOTHER
      // account's wrapper on top of the same base (src/account-failover.ts).
      baseCliPath: cliPath
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
            account,
            // The resolved list, so this account's language model can offer
            // the others when it runs out of usage. `accounts` itself stays
            // stripped by cleanProviderOptions.
            failoverAccounts: accounts
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
async function buildAgentRegistry(config) {
  const options = config.provider?.[PROVIDER_ID2]?.options;
  const configured = options?.defaultSubagentModel;
  setDefaultSubagentModel(
    typeof configured === "string" ? configured : void 0
  );
  const configuredTtl = options?.defaultSubagentCacheTtl;
  setDefaultSubagentCacheTtl(
    typeof configuredTtl === "string" ? configuredTtl : void 0
  );
  setProviderFallbackModels(parseFallbackModelList(options?.fallbackModels));
  const records = await readAgentMarkdownRecords(
    agentDirectories(
      process.env.HOME ?? process.env.USERPROFILE,
      getOpencodeProjectDirectory()
    )
  );
  for (const [name, agent] of Object.entries(config.agent ?? {})) {
    const bag = agent.options ?? {};
    const pick = (key) => {
      const value = agent[key] ?? bag[key];
      return typeof value === "string" ? value : void 0;
    };
    const declaredChain = parseFallbackModelList(
      agent.fallbackModels ?? bag.fallbackModels
    );
    records[name] = {
      mode: pick("mode") ?? records[name]?.mode,
      model: pick("model") ?? records[name]?.model,
      forceModel: pick("forceModel") ?? records[name]?.forceModel,
      reasoningEffort: pick("reasoningEffort") ?? records[name]?.reasoningEffort,
      cacheTtl: pick("cacheTtl") ?? records[name]?.cacheTtl,
      fallbackModels: declaredChain.length ? declaredChain : records[name]?.fallbackModels
    };
  }
  setAgentRegistry(records);
  log.debug("agent registry built", {
    agents: Object.keys(records).length,
    defaultSubagentModel: getDefaultSubagentModel()
  });
}
function extractDeletedSessionId(event) {
  const payload = event?.payload ?? event;
  if (!payload || payload.type !== "session.deleted") return void 0;
  const properties = payload.properties;
  const id = properties?.info?.id;
  return typeof id === "string" && id.length > 0 ? id : void 0;
}
var server = async (input) => {
  cleanupStaleUnscopedInstall();
  ensureProcessExitCleanup();
  const opencodeVersion = pickOpencodeVersion(input);
  if (input && typeof input === "object" && "client" in input) {
    setOpencodeClient(input.client);
  }
  setOpencodeProjectDirectory(pickOpencodeDirectory(input));
  return {
    config: async (config) => {
      if (registerSideQuestionCommand(config)) ownsSideQuestionCommand = true;
      registerDoctorCommand(config);
      registerBundledSkillPath(config);
      config.provider ??= {};
      await buildAgentRegistry(config);
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
    // current turn. A deleted session has no turn left to abort, and its
    // `claude` child would otherwise linger until the idle timer or LRU
    // pressure took it, with its session id kept for a resume that never comes.
    event: async ({ event }) => {
      const sessionID = extractDeletedSessionId(event);
      if (!sessionID) return;
      const released = deleteActiveProcessesForSession(sessionID);
      if (released.length > 0) {
        log.info("released claude state for deleted session", { sessionID, released });
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
    // /btw is asked from here, the moment the command is typed, busy or not.
    // The message itself still goes through: opencode queues it behind the
    // running turn and the aside branch in the language model then answers it
    // from the early answer, so the exchange is kept in this conversation.
    "command.execute.before": async (input2) => {
      if (input2.command !== "btw" || !ownsSideQuestionCommand) return;
      await handleBtwCommand(getOpencodeClient(), input2);
    },
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
  server,
  setup: createV2Setup({
    createProvider: createClaudeCode,
    defaultProxyTools: DEFAULT_PROXY_TOOL_NAMES,
    loadConfig: loadMergedOpencodeConfig,
    buildAgentRegistry: (config) => buildAgentRegistry(config)
  })
};
export {
  ClaudeCodeLanguageModel,
  DEFAULT_PROXY_TOOL_NAMES,
  _resetPlanModeWarningForTests,
  applyPermissionPreset,
  bridgeOpencodeMcp,
  buildAgentRegistry,
  claudeCodeProviders,
  configModelsForProvider,
  createClaudeCode,
  index_default as default,
  defaultModels,
  extractDeletedSessionId,
  getAgentRegistry,
  getDefaultSubagentModel,
  registerDoctorCommand,
  registerSideQuestionCommand,
  resolveAgentModel,
  warnIfPlanModeCannotExit
};
//# sourceMappingURL=index.js.map