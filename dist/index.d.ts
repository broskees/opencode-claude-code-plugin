import { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';

type ModelID = string;
type ProviderID = string;
type OpenCodeModel = {
    id: ModelID;
    providerID: ProviderID;
    api: {
        id: string;
        url: string;
        npm: string;
    };
    name: string;
    family?: string;
    capabilities: {
        temperature: boolean;
        reasoning: boolean;
        attachment: boolean;
        toolcall: boolean;
        input: {
            text: boolean;
            audio: boolean;
            image: boolean;
            video: boolean;
            pdf: boolean;
        };
        output: {
            text: boolean;
            audio: boolean;
            image: boolean;
            video: boolean;
            pdf: boolean;
        };
        interleaved: boolean | {
            field: "reasoning_content" | "reasoning_details";
        };
    };
    cost: {
        input: number;
        output: number;
        cache: {
            read: number;
            write: number;
        };
    };
    limit: {
        context: number;
        input?: number;
        output: number;
    };
    status: "alpha" | "beta" | "deprecated" | "active";
    options: Record<string, unknown>;
    headers: Record<string, string>;
    release_date: string;
    variants?: Record<string, Record<string, unknown>>;
};
type OpenCodeProvider = {
    id: ProviderID;
    name?: string;
    source?: string;
    options?: Record<string, unknown>;
    models: Record<string, OpenCodeModel>;
};
type OpenCodeConfig = {
    provider?: Record<string, {
        name?: string;
        npm?: string;
        env?: string[];
        options?: Record<string, unknown>;
        models?: Record<string, unknown>;
    }>;
};
/**
 * Bus events surface to plugins. Shape mirrors what opencode core publishes
 * via `GlobalBus.emit("event", { directory, payload: { type, properties } })`
 * but kept loose since opencode adds events over time and this plugin only
 * reacts to a small subset (currently just `global.disposed`).
 */
type OpenCodeEvent = {
    type?: string;
    payload?: {
        type?: string;
        properties?: Record<string, unknown>;
    };
    [key: string]: unknown;
};
/**
 * Input shape for the `chat.params` hook. opencode passes the agent name
 * for the current call ("default", "compaction", "title", etc.), the
 * resolved model, and the user message. Output is the mutable params bag
 * the hook can adjust before opencode forwards them to the LM.
 *
 * The plugin injects `input.agent` as `opencodeAgent` and `input.sessionID`
 * as `opencodeSessionID` into `output.options` so the language model can
 * read them from `providerOptions[providerID]` on every LLM request.
 * `opencodeSessionID` serves as a fallback affinity token when the
 * `x-session-affinity` request header is absent (provider switch
 * mid-session, title synthesis paths, older opencode versions).
 */
type OpenCodeChatParamsInput = {
    sessionID?: string;
    agent?: string;
    model?: OpenCodeModel & {
        providerID: ProviderID;
    };
    provider?: {
        source?: string;
        info?: {
            id?: ProviderID;
        };
        options?: Record<string, unknown>;
    };
    message?: unknown;
};
type OpenCodeChatParamsOutput = {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    options?: Record<string, unknown>;
};
type OpenCodeHooks = {
    config?: (input: OpenCodeConfig) => Promise<void>;
    provider?: {
        id: string;
        models?: (provider: OpenCodeProvider) => Promise<Record<string, OpenCodeModel>>;
    };
    event?: (input: {
        event: OpenCodeEvent;
    }) => Promise<void>;
    "chat.params"?: (input: OpenCodeChatParamsInput, output: OpenCodeChatParamsOutput) => Promise<void>;
};
type OpenCodePlugin = (input: unknown, options?: Record<string, unknown>) => Promise<OpenCodeHooks>;

type LogLevel = "debug" | "info" | "notice" | "warn" | "error";
type LogMode = "silent" | "debug";

interface ClaudeCodeConfig {
    provider: string;
    cliPath: string;
    /** Drive interactive claude (subscription) instead of headless --print. */
    interactive?: boolean;
    /** Deprecated/no-op with interactive: Claude Code's TUI requires manual confirmation for bypassPermissions. */
    interactiveBypass?: boolean;
    /** With interactive: built-in tools to allow without prompting (replaces
     *  the default Bash/Edit/Write/Read/WebFetch list; MCP wildcards are always
     *  derived from the bridged config). */
    interactiveAllowTools?: string[];
    /** With interactive: append this plugin's own prompts via --append-system-prompt-file. Defaults to true. */
    interactiveSystemPrompt?: boolean;
    cwd?: string;
    account?: string;
    configDir?: string;
    providerID?: string;
    skipPermissions?: boolean;
    permissionMode?: PermissionMode;
    mcpConfig?: string | string[];
    strictMcpConfig?: boolean;
    bridgeOpencodeMcp?: boolean;
    bridgeOpencodeSkills?: boolean;
    controlRequestBehavior?: ControlRequestBehavior;
    controlRequestToolBehaviors?: Record<string, ControlRequestBehavior>;
    controlRequestDenyMessage?: string;
    proxyTools?: string[];
    proxyToolTimeoutMs?: Record<string, number>;
    webSearch?: WebSearchRouting;
    hotReloadMcp?: boolean;
    proxyOpencodeMcpTools?: boolean;
    multiStepContinuation?: boolean;
    autoContinueIncompleteTurns?: boolean | "smart";
    compactionModel?: string;
    ignoreAnthropicApiKey?: boolean;
    logging?: LoggingConfig;
}
interface LoggingConfig {
    /**
     * Persist log activity (DEBUG / INFO / NOTICE / WARN / ERROR — those
     * passing `level`) to a file. Default: `false`. When `false`, entries
     * below WARN vanish entirely; WARN / ERROR still surface in the TUI via
     * stderr. Set to `true` to capture the audit trail to disk for review
     * via `tail` / `grep`.
     */
    file?: boolean;
    /**
     * Optional custom directory for the file log. Defaults to
     * `~/.local/share/opencode-claude-code/`. Has no effect when `file:false`.
     */
    dir?: string;
    /**
     * TUI policy. `"silent"` (default) routes DEBUG / INFO / NOTICE to file
     * only; WARN / ERROR still bubble in the TUI as they always do. `"debug"`
     * additionally echoes every emitted level to stderr (which opencode's TUI
     * surfaces as warning bubbles).
     */
    mode?: LogMode;
    /**
     * Minimum level to emit anywhere. Anything below the threshold is dropped
     * before either destination decides what to do. Order:
     * `debug` < `info` < `notice` < `warn` < `error`. Default: `"info"`.
     */
    level?: LogLevel;
}
type WebSearchRouting = "claude" | "disabled" | (string & {});
interface ClaudeCodeProviderSettings {
    cliPath?: string;
    /** Drive interactive claude (subscription) instead of headless --print. */
    interactive?: boolean;
    /** Deprecated/no-op with interactive: Claude Code's TUI requires manual confirmation for bypassPermissions. */
    interactiveBypass?: boolean;
    /** With interactive: built-in tools to allow without prompting (replaces
     *  the default Bash/Edit/Write/Read/WebFetch list; MCP wildcards are always
     *  derived from the bridged config). */
    interactiveAllowTools?: string[];
    /** With interactive: append this plugin's own prompts via --append-system-prompt-file. Defaults to true. */
    interactiveSystemPrompt?: boolean;
    cwd?: string;
    name?: string;
    providerID?: string;
    account?: string;
    configDir?: string;
    accounts?: string[];
    skipPermissions?: boolean;
    permissionMode?: PermissionMode;
    mcpConfig?: string | string[];
    strictMcpConfig?: boolean;
    /**
     * Auto-translate opencode's `mcp` config block (from opencode.json/jsonc
     * discovered via cwd/OPENCODE_CONFIG/XDG) into a Claude CLI `--mcp-config`
     * file and pass it through on spawn. Defaults to `true` so the CLI sees
     * the same MCP servers opencode is configured with.
     */
    bridgeOpencodeMcp?: boolean;
    /**
     * Expose skills found in opencode's skill directories
     * (`.opencode/skills/` walking up from cwd, then `~/.opencode/skills/`,
     * `OPENCODE_CONFIG_DIR/skills/`, and `~/.config/opencode/skills/`) to the
     * Claude CLI's native Skill tool, via a session-scoped `--plugin-dir`.
     * They register as `opencode-skills:<name>`. Defaults to `true`: opencode
     * already advertises these skills in the system prompt it forwards, so
     * without the bridge the model calls `Skill` and gets `Unknown skill`.
     */
    bridgeOpencodeSkills?: boolean;
    /**
     * Behavior for Claude CLI `control_request` permission checks
     * (`subtype: can_use_tool`) when `skipPermissions` is false.
     *
     * - allow: approve tool use requests automatically.
     * - deny: reject tool use requests automatically.
     *
     * Defaults to `allow`.
     */
    controlRequestBehavior?: ControlRequestBehavior;
    /**
     * Optional per-tool overrides for control-request behavior.
     * Keys are Claude tool names (eg. `Bash`, `Read`, `mcp__github__list_prs`) and
     * values are `allow` or `deny`.
     */
    controlRequestToolBehaviors?: Record<string, ControlRequestBehavior>;
    /**
     * Custom deny message sent back to Claude CLI when behavior resolves to deny.
     */
    controlRequestDenyMessage?: string;
    /**
     * Proxy these Claude built-in tools through opencode instead of letting the
     * CLI execute them directly. When a tool is listed here, the plugin:
     *   - passes `--disallowedTools <ClaudeName>` to the CLI, and
     *   - exposes an equivalent tool via an in-process HTTP MCP server named
     *     `opencode_proxy`. Claude calls the MCP tool, which blocks on
     *     opencode's tool executor (with its native permission UI) and returns
     *     the result.
     *
      * Supported: `bash`, `write`, `edit`, `webfetch`, `task`, `question`. Leave empty or unset to disable proxying.
      *
      * `task` proxies Claude CLI's `Agent` (subagent dispatch) tool through
      * opencode's `task` tool, so subagent calls run under opencode's
      * configured subagent set (build/general/custom) with opencode's
      * permission and lifecycle handling, instead of Claude CLI's
      * internal-only general-purpose / Explore / Plan options. The calling
      * agent must have `permission.task: allow` for the target subagent
      * (see opencode's agent docs).
      *
      * `question` proxies Claude CLI's `AskUserQuestion` through opencode's
      * native `question` tool (TUI form with options + custom answer). The
      * calling agent must have `permission.question: allow`. Version-gated:
      * silently dropped on opencode builds that lack the `question` registry
      * entry, in which case the deny/markdown fallback applies.
      */
    proxyTools?: string[];
    /**
     * Per-tool proxy call timeouts in milliseconds, keyed by the proxy tool
     * name (`bash`, `edit`, `write`, `webfetch`, `task`, `question` —
     * case-insensitive). When a proxied tool call waits longer than its
     * deadline for opencode to resolve it, the call is rejected and Claude
     * receives a timeout error.
     *
     * Defaults (used when a tool is absent here): `bash`/`edit`/`write`/
     * `webfetch` → 10 min (matches Claude CLI's Bash ceiling); `task` and
     * `task_batch` → no deadline; `question` → 30 min (operator AFK). Setting
     * a key here replaces the default for that tool. Use `0` to disable the
     * configured deadline; a Bash call's own positive `input.timeout` still
     * acts as its minimum deadline.
     *
     * For `bash` specifically the call's own `input.timeout` is honoured on
     * top: the effective deadline is `max(resolved, input.timeout)`, so a
     * long build the caller explicitly asked to run is never undercut.
     */
    proxyToolTimeoutMs?: Record<string, number>;
    /**
     * Strip `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the environment of
     * every spawned `claude` process. When an API key is present, Claude Code
     * authenticates with it (pay-as-you-go Console billing) instead of the
     * logged-in Pro/Max subscription — silently bypassing the Agent SDK plan
     * credit. Set this to `true` to force the CLI to fall back to its stored
     * subscription auth. Defaults to `false` (the key is passed through, so
     * deliberate API-key users are unaffected). Regardless of this setting, the
     * plugin logs a one-time warning at startup when an API key is detected.
     */
    ignoreAnthropicApiKey?: boolean;
    /**
     * Routing for Claude's built-in `WebSearch` tool.
     *
     * - `"claude"` (default): Claude CLI runs WebSearch internally via
     *   Anthropic's web search. No MCP setup required, no extra cost.
     * - `"<opencode-tool-name>"` (e.g. `"websearch_web_search_exa"`): forward
     *   the call to that opencode-side tool with `executed:false`. Requires
     *   the corresponding MCP server to be configured in opencode.
     * - `"disabled"`: prevent the model from calling WebSearch entirely
     *   (passes `WebSearch` via `--disallowedTools`).
     */
    webSearch?: WebSearchRouting;
    /**
     * Detect mid-session opencode MCP config changes and respawn the
     * underlying claude process so newly enabled / disabled MCPs become
     * visible to the model without restarting opencode or starting a new
     * chat. Eviction happens at the start of the next user turn (never mid
     * tool-call) and `--session-id` is preserved so the conversation
     * continues seamlessly. Defaults to `true`.
     *
     * Set to `false` to keep the previous behavior (cached subprocess
     * survives MCP changes until the chat is reset).
     */
    hotReloadMcp?: boolean;
    /**
     * Route opencode MCP server tools through the in-process `opencode_proxy`
     * MCP server instead of bridging them directly into Claude CLI's
     * `--mcp-config`. With both layers configured for the same MCP server,
     * direct bridging causes each tool invocation to execute twice — once by
     * Claude CLI's own MCP child process and once by opencode. Routing through
     * the proxy keeps a single execution site (opencode) while preserving the
     * tool-call/result surface in opencode's UI and its permission prompts.
     *
     * Defaults to `true`. Set to `false` to restore the prior direct-bridge
     * behavior (Claude CLI executes MCP tools itself; opencode also re-executes
     * — accept the duplication if you need Claude to invoke the tool without
     * an opencode round-trip).
     */
    proxyOpencodeMcpTools?: boolean;
    /**
     * Append a short system-prompt hint that nudges Claude to chain
     * multiple tool calls within a single turn instead of pausing for user
     * confirmation between subtasks. Each turn boundary in opencode
     * requires the user to manually press "continue" to resume, so for
     * multi-step tasks this option reduces friction. Defaults to `true`.
     *
     * Set to `false` if you prefer the un-nudged model behavior (Claude
     * decides when to end the turn entirely on its own).
     */
    multiStepContinuation?: boolean;
    /**
     * Smartly continue incomplete Claude CLI results inside the same opencode
     * turn. Claude CLI sometimes emits `result` after reasoning/tool activity
     * without a useful final answer, which makes opencode stop and wait for the
     * user to type "continue". With the default `"smart"`, the plugin detects
     * those incomplete result boundaries, feeds Claude a small continuation
     * message internally, and keeps the opencode stream open. Final answers,
     * questions, blockers, errors, aborts, and safety-budget exhaustion still
     * stop normally.
     *
     * Set to `false` to disable.
     */
    autoContinueIncompleteTurns?: boolean | "smart";
    /**
     * Model id used when opencode invokes `/compact`. Defaults to
     * `claude-haiku-4-5` — fast, cheap, strong structured summarizer. Set
     * to override per-project in `opencode.json` / `opencode.jsonc`; the
     * `CLAUDE_CODE_COMPACTION_MODEL` env var overrides this in turn for
     * one-off runs without editing config.
     */
    compactionModel?: string;
    /**
     * Logger configuration. See `LoggingConfig` for fields. Env vars
     * (`OPENCODE_CLAUDE_CODE_LOG_FILE`, `OPENCODE_CLAUDE_CODE_LOG_DIR`,
     * `OPENCODE_CLAUDE_CODE_LOG_LEVEL`, `DEBUG=opencode-claude-code`) override
     * these values when explicitly set, so a developer can flip behavior for
     * one process without editing opencode.jsonc.
     */
    logging?: LoggingConfig;
}
type PermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
type ControlRequestBehavior = "allow" | "deny";
/**
 * Claude CLI stream-json message types.
 */
interface ClaudeStreamMessage {
    type: string;
    subtype?: string;
    request_id?: string;
    event?: ClaudeStreamMessage;
    request?: {
        subtype?: string;
        tool_name?: string;
        input?: Record<string, unknown>;
        tool_use_id?: string;
        permission_suggestions?: unknown[];
        blocked_path?: string;
        decision_reason?: string;
        title?: string;
        display_name?: string;
        agent_id?: string;
        description?: string;
    };
    message?: {
        role?: string;
        model?: string;
        content?: Array<{
            type: string;
            text?: string;
            name?: string;
            input?: unknown;
            id?: string;
            tool_use_id?: string;
            content?: string | Array<{
                type: string;
                text?: string;
            }>;
            thinking?: string;
        }>;
    };
    tool?: {
        name?: string;
        id?: string;
        input?: unknown;
    };
    tool_result?: {
        tool_use_id?: string;
        content?: string | Array<{
            type: string;
            text?: string;
        }>;
        is_error?: boolean;
    };
    session_id?: string;
    total_cost_usd?: number;
    duration_ms?: number;
    duration_api_ms?: number;
    id?: string;
    result?: string;
    is_error?: boolean;
    num_turns?: number;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        iterations?: Array<{
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
        }>;
    };
    content_block?: {
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: string;
        thinking?: string;
    };
    delta?: {
        type: string;
        text?: string;
        partial_json?: string;
        thinking?: string;
    };
    index?: number;
}

interface DiagnosticsProviderEntry {
    name?: string;
    options?: Record<string, unknown>;
}

declare class ClaudeCodeLanguageModel implements LanguageModelV3 {
    readonly specificationVersion = "v3";
    readonly modelId: string;
    private readonly config;
    constructor(modelId: string, config: ClaudeCodeConfig);
    readonly supportedUrls: Record<string, RegExp[]>;
    get provider(): string;
    private toUsage;
    private toFinishReason;
    private requestScope;
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
    private effectiveMcpConfig;
    /** Resolve ProxyToolDef[] for the configured proxyTools names. */
    private resolvedProxyTools;
    /**
     * Resolve ProxyToolDef[] for opencode's MCP-bridged tools so they go
     * through the in-process proxy instead of being bridged into Claude CLI's
     * `--mcp-config`. Direct bridging causes double execution because both
     * Claude CLI's own MCP child and opencode hold their own connection to
     * the same server; routing through the proxy keeps a single execution
     * site (opencode). Returns null when the feature is disabled, the SDK
     * client is unavailable, or no MCP servers are configured.
     */
    private resolvedProxyMcpTools;
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
    private fetchLiveToolInfo;
    /**
     * Create a proxy MCP server for a single active Claude process/session.
     * The process lifecycle owns the server lifecycle via session-manager.
     */
    private ensureProxyServer;
    private extractToolResult;
    private extractPendingProxyResult;
    private wasPendingProxyCallEmitted;
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
    private sessionAffinity;
    private controlRequestBehaviorForTool;
    private writeControlResponse;
    /**
     * Handle Claude stream-json control requests (`can_use_tool`, etc.) and
     * respond via stdin with a matching `control_response`.
     */
    private handleControlRequest;
    private getReasoningEffort;
    private getOpencodeAgent;
    private isCompactionCall;
    /**
     * Pick the model used to handle /compact. Precedence:
     *   1. `CLAUDE_CODE_COMPACTION_MODEL` env var (per-process override)
     *   2. `compactionModel` provider setting (opencode.json / .jsonc)
     *   3. Built-in default (claude-haiku-4-5)
     */
    private resolveCompactionModel;
    private thinkingCliOptions;
    private latestUserText;
    private synthesizeTitle;
    private doGenerateViaStream;
    doGenerate(options: LanguageModelV3CallOptions): Promise<Awaited<ReturnType<LanguageModelV3["doGenerate"]>>>;
    doStream(options: LanguageModelV3CallOptions): Promise<Awaited<ReturnType<LanguageModelV3["doStream"]>>>;
}

interface BridgedMcp {
    /** Path to the temp file containing the translated `--mcp-config`. */
    path: string;
    /** Stable hash of the merged opencode mcp block (pre-translation). */
    hash: string;
    /**
     * Names of opencode MCP servers that were bridged into Claude CLI's
     * `--mcp-config`. Excludes any servers passed in `excludeServers`.
     */
    serverNames: string[];
    /**
     * Names of every enabled opencode MCP server after merge + runtime
     * overlay, regardless of whether they ended up bridged or excluded.
     * Callers (e.g. the proxy-tool builder) use this to decide which
     * `<server>_<tool>` IDs in opencode's tool catalog are MCP-origin.
     */
    allEnabledServerNames: string[];
}
/**
 * Per-server runtime status from opencode's `client.mcp.status()`. Used as
 * an overlay on top of the on-disk merged config so opencode's UI-toggled
 * state — which lives only in-memory; `connect()`/`disconnect()` never
 * touch disk — propagates to the bridged claude subprocess.
 *
 * Treatment per server:
 *   - "connected"      → force `enabled: true` (mirror opencode)
 *   - any other status → force `enabled: false` (don't ship a server
 *     opencode can't run; user fixes it in opencode first)
 *   - missing entry    → leave disk value
 *
 * Omit the overlay and the bridge falls back to disk-only.
 */
type RuntimeMcpStatus = Record<string, string>;
/**
 * Read opencode config layers, deep-merge their `mcp` blocks per opencode's
 * own semantics, optionally apply an opencode runtime-status overlay, then
 * translate each server to Claude CLI format, write a scratch file, and
 * return its path + a stable hash. Returns null when no enabled MCP servers
 * remain after the merge + overlay.
 */
declare function bridgeOpencodeMcp(cwd: string, runtimeStatus?: RuntimeMcpStatus, excludeServers?: ReadonlySet<string>): BridgedMcp | null;

declare const defaultModels: Record<string, OpenCodeModel>;

interface ClaudeCodeProvider {
    specificationVersion: "v3";
    (modelId: string): LanguageModelV3;
    languageModel(modelId: string): LanguageModelV3;
}
declare function createClaudeCode(settings?: ClaudeCodeProviderSettings): ClaudeCodeProvider;
/**
 * Build models in OpenCode's config schema format (flat properties like
 * `temperature`, `reasoning`, `cost.cache_read`, `modalities`, etc.)
 * so the config-path provider loader parses them correctly.
 */
declare function configModelsForProvider(providerModels: OpenCodeProvider["models"], providerID: string, modelSuffix?: string): Record<string, Record<string, unknown>>;
/**
 * Narrow opencode's full provider map down to the ones this plugin owns
 * (`claude-code` plus every `claude-code-<account>` expansion) so startup
 * diagnostics never report another provider's options.
 */
declare function claudeCodeProviders(providers: Record<string, DiagnosticsProviderEntry> | undefined): Record<string, DiagnosticsProviderEntry>;
declare const _default: {
    id: string;
    server: OpenCodePlugin;
};

export { type ClaudeCodeConfig, ClaudeCodeLanguageModel, type ClaudeCodeProvider, type ClaudeCodeProviderSettings, type ClaudeStreamMessage, type OpenCodeHooks, type OpenCodeModel, type OpenCodePlugin, bridgeOpencodeMcp, claudeCodeProviders, configModelsForProvider, createClaudeCode, _default as default, defaultModels };
