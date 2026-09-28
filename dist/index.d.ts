import { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';

/**
 * Hand-written structural mirror of the slice of opencode 2.x's plugin API
 * this package touches. Same approach as `opencode-types.ts` for V1: no
 * runtime or type dependency on `@opencode/plugin`, whose promise API pulls in
 * an Effect release candidate we have no other use for.
 *
 * Read off the shipped `.d.ts` of `@opencode/plugin@2.0.11`, `@opencode/schema`
 * and `@opencode/client` at the same version, not off the website, whose
 * provider docs describe a metadata-only surface and omit the `aisdk` domain
 * entirely. Every field here is one we read or write; everything else is left
 * out on purpose so drift in an unused corner cannot break the build.
 */

interface V2Registration {
    readonly dispose: () => Promise<void>;
}
/** `@opencode/schema/provider` `Provider.Info`, the fields we set. */
interface V2ProviderInfo {
    id: string;
    name: string;
    activation: "auto" | "enabled" | "disabled";
    package: string;
    settings?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
}
interface V2ModelVariant {
    id: string;
    settings?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
}
interface V2ModelCost {
    input: number;
    output: number;
    cache: {
        read: number;
        write: number;
    };
}
/** `@opencode/schema/model` `Model.Info`, every required field plus the optional ones we fill. */
interface V2ModelInfo {
    id: string;
    modelID: string;
    providerID: string;
    name: string;
    family?: string;
    capabilities: {
        tools: boolean;
        input: string[];
        output: string[];
    };
    variants: V2ModelVariant[];
    time: {
        released: number;
    };
    cost: V2ModelCost[];
    status: "alpha" | "beta" | "deprecated" | "active";
    enabled: boolean;
    limit: {
        context: number;
        input?: number;
        output: number;
    };
    settings?: Record<string, unknown>;
    headers?: Record<string, string>;
    package?: string;
}
interface V2ProviderRecord {
    readonly provider: V2ProviderInfo;
    readonly models: ReadonlyMap<string, V2ModelInfo>;
}
interface V2ProviderEditor {
    list(): readonly V2ProviderRecord[];
    get(providerID: string): V2ProviderRecord | undefined;
    add(input: {
        info: V2ProviderInfo;
        models: readonly V2ModelInfo[];
    }): void;
    update(providerID: string, update: (provider: V2ProviderInfo) => void): void;
    remove(providerID: string): void;
    readonly models: {
        set(providerID: string, models: readonly V2ModelInfo[]): void;
    };
}
interface V2AISDKSdkEvent {
    readonly model: V2ModelInfo;
    readonly package: string;
    readonly options: Record<string, unknown>;
    sdk?: unknown;
}
interface V2AISDKLanguageEvent {
    readonly model: V2ModelInfo;
    readonly sdk: unknown;
    readonly options: Record<string, unknown>;
    language?: LanguageModelV3;
}
type V2RequestKind = "primary" | "compaction" | "title" | "generate";
interface V2ModelRequestEvent {
    readonly sessionID: string;
    readonly agent: string;
    readonly model: {
        id: string;
        providerID: string;
        variant?: string;
    };
    readonly kind: V2RequestKind;
    baseURL?: string;
    headers: Record<string, string>;
}
interface V2ModelHookOptions {
    readonly providerID?: string;
}
/** `@opencode/schema/prompt-input` `Prompt`: we only rewrite `text`. */
type V2Prompt = {
    text?: string;
} & Record<string, unknown>;
type V2Delivery = "steer" | "queue";
interface V2CommandInvocation {
    readonly sessionID: string;
    readonly prompt: V2Prompt;
    readonly delivery: V2Delivery;
}
interface V2CommandDefinition {
    readonly name: string;
    readonly description?: string;
    readonly execute: (input: V2CommandInvocation) => Promise<void>;
}
/** `session.deleted` is the one event this plugin acts on. */
interface V2Event {
    readonly type?: string;
    readonly data?: {
        readonly sessionID?: string;
    } & Record<string, unknown>;
}
interface V2Context {
    readonly app: {
        readonly version: string;
    };
    readonly location: {
        readonly directory: string;
    };
    readonly options: Record<string, unknown>;
    readonly provider: {
        transform(callback: (editor: V2ProviderEditor) => void): Promise<V2Registration>;
    };
    readonly aisdk: {
        hook(name: "sdk", callback: (event: V2AISDKSdkEvent) => Promise<void> | void, options?: V2ModelHookOptions): Promise<V2Registration>;
        hook(name: "language", callback: (event: V2AISDKLanguageEvent) => Promise<void> | void, options?: V2ModelHookOptions): Promise<V2Registration>;
    };
    readonly session: {
        hook(name: "model.request", callback: (event: V2ModelRequestEvent) => Promise<void> | void, options?: V2ModelHookOptions): Promise<V2Registration>;
        prompt?(input: V2Prompt & {
            sessionID: string;
            delivery?: V2Delivery;
        }): Promise<unknown>;
    };
    readonly command?: {
        transform(callback: (editor: {
            add(definition: V2CommandDefinition): void;
        }) => void): Promise<V2Registration>;
    };
    readonly event?: {
        subscribe(options?: {
            signal?: AbortSignal;
        }): AsyncIterable<V2Event>;
    };
    readonly skill?: {
        transform(callback: (editor: {
            get(id: string): unknown;
            add(skill: {
                id: string;
                name: string;
                description?: string;
                path: string;
                content: string;
            }): void;
        }) => void): Promise<V2Registration>;
    };
}
/** What `setup` may return: a cleanup run when opencode unloads the plugin. */
type V2Cleanup = () => void | Promise<void>;

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
        interleaved: boolean | string | {
            field: "reasoning" | "reasoning_content" | "reasoning_text" | string;
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
    command?: Record<string, {
        template: string;
        description?: string;
        agent?: string;
        model?: string;
        variant?: string;
        subtask?: boolean;
    }>;
    provider?: Record<string, {
        name?: string;
        npm?: string;
        env?: string[];
        options?: Record<string, unknown>;
        models?: Record<string, unknown>;
    }>;
    agent?: Record<string, Record<string, unknown>>;
    skills?: {
        paths?: string[];
        urls?: string[];
    };
};
/**
 * Bus events surface to plugins. Shape mirrors what opencode core publishes
 * via `GlobalBus.emit("event", { directory, payload: { type, properties } })`
 * but kept loose since opencode adds events over time and this plugin only
 * reacts to a small subset (currently just `session.deleted`).
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
    "command.execute.before"?: (input: {
        command: string;
        sessionID: string;
        arguments: string;
    }, output: {
        parts: unknown[];
    }) => Promise<void>;
};
type OpenCodePlugin = (input: unknown, options?: Record<string, unknown>) => Promise<OpenCodeHooks>;

type LogLevel = "debug" | "info" | "notice" | "warn" | "error";
type LogMode = "silent" | "debug";

interface ClaudeCodeConfig {
    provider: string;
    cliPath: string;
    /**
     * Which opencode major this model was created by, which decides the tool
     * vocabulary its stream uses (src/host-tools.ts). Set only by the V2
     * entrypoint's `sdk` hook; absent means opencode 1.x. Per model rather than
     * per process on purpose: opencode 1.18 also calls a dual export's `setup`,
     * so nothing process-wide may decide it.
     */
    hostApi?: "v1" | "v2";
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
    /**
     * Every account the provider expansion produced, so a limited account can
     * offer the others. Set by `providerConfig`, not by the user.
     */
    failoverAccounts?: string[];
    /**
     * The CLI path BEFORE the per-account wrapper substitution, so a failover
     * can build another account's wrapper on top of the same binary. Set by
     * `providerConfig`, not by the user.
     */
    baseCliPath?: string;
    accountFailover?: AccountFailoverMode;
    providerID?: string;
    skipPermissions?: boolean;
    /**
     * Widened past `PermissionMode` because a resolved `permissionPreset` puts
     * its own internal token here (`READ_ONLY_PERMISSION_MODE`), which
     * `buildCliArgs` translates to CLI flags. The operator-facing option on
     * `ClaudeCodeProviderSettings` stays a plain `PermissionMode`.
     */
    permissionMode?: EffectivePermissionMode;
    /** The preset this config was resolved from, for diagnostics. */
    permissionPreset?: PermissionPreset;
    mcpConfig?: string | string[];
    strictMcpConfig?: boolean;
    bridgeOpencodeMcp?: boolean;
    controlRequestBehavior?: ControlRequestBehavior;
    controlRequestToolBehaviors?: Record<string, ControlRequestBehavior>;
    controlRequestDenyMessage?: string;
    proxyTools?: string[];
    proxyOpencodeTools?: string[];
    stripContextReminders?: boolean;
    extraDisallowedTools?: string[];
    proxyToolTimeoutMs?: Record<string, number>;
    /**
     * Route `ExitPlanMode` through opencode's native `question` tool so plan
     * approval is a real form instead of a "(yes/no)" line the operator has to
     * answer in prose. Off by default because it cannot currently fire: headless
     * `--print` is not offered an `ExitPlanMode` tool at all, and this bridge
     * keys on that tool call. See the plan-mode gotcha in AGENTS.md.
     */
    planModeQuestion?: boolean;
    webSearch?: WebSearchRouting;
    hotReloadMcp?: boolean;
    proxyOpencodeMcpTools?: boolean;
    multiStepContinuation?: boolean;
    autoContinueIncompleteTurns?: boolean | "smart";
    compactionModel?: string;
    ignoreAnthropicApiKey?: boolean;
    /** Kill an idle headless Claude worker after this many milliseconds. */
    idleProcessTimeoutMs?: number;
    /** Stage opencode skills as a `--plugin-dir` so Claude's Skill tool can run them. */
    bridgeOpencodeSkills?: boolean;
    /** Leave out the skills the Claude session already loads natively. Default true. */
    bridgeSkipNativeSkills?: boolean;
    /** Append a one-line cost / duration / cache footer to each finished turn. */
    turnStats?: boolean;
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
/**
 * What happens when the account a conversation runs on is out of usage.
 * `"ask"` (default) shows the operator a form listing the other configured
 * accounts and applies the pick inside the same turn; `"off"` keeps today's
 * behaviour, where the turn ends with the rate-limit error.
 */
type AccountFailoverMode = "ask" | "off";
interface ClaudeCodeProviderSettings {
    cliPath?: string;
    /** Internal: set by the opencode 2 entrypoint. See `ClaudeCodeConfig.hostApi`. */
    hostApi?: "v1" | "v2";
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
    /**
     * Every account the provider expansion produced. Written by the config
     * hook; setting it by hand only limits what a limited account may offer.
     */
    failoverAccounts?: string[];
    /** The CLI path before the per-account wrapper substitution. */
    baseCliPath?: string;
    /**
     * When this account is out of usage, show the operator a form listing the
     * other configured accounts and continue the task on the pick, inside the
     * same opencode turn. `"ask"` by default, which only does anything when
     * more than one account is configured. `"off"` keeps the plain rate-limit
     * error. See README "Account failover".
     */
    accountFailover?: AccountFailoverMode;
    /**
     * Model that subagents run on when their own definition pins nothing.
     * Unset means no implicit override at all, so an agent keeps inheriting the
     * caller's model exactly as opencode intends. See `src/agent-models.ts`.
     */
    defaultSubagentModel?: string;
    /**
     * Prompt cache TTL (`"5m"` or `"1h"`) for subagents whose own definition
     * states no `cacheTtl`. Unset (the default) means the plugin sets nothing
     * and the CLI keeps choosing, which is 1 hour on a subscription. Setting
     * `"5m"` is the cheaper trade for short-lived workers that never re-read
     * the cache they wrote. See `resolveAgentCacheTtl` in `src/agent-models.ts`.
     */
    defaultSubagentCacheTtl?: string;
    /**
     * Models to try, in order, when the model a turn would have run on is
     * refused. The default for every agent that declares no `fallbackModels` of
     * its own; a per-agent list replaces this one rather than extending it.
     *
     * Unset means no chain at all, so an upgrade never moves a turn onto a
     * model nobody picked. Entries are model NAMES from this plugin's own list
     * (an unknown one is refused with a WARN and skipped) and always run on the
     * account the turn arrived on: this never crosses accounts, which is what
     * `accountFailover` is for. Only two things arm it, the CLI refusing the
     * model outright and a usage limit with no other account to offer. See
     * README "Fallback model chain" and `src/model-fallback.ts`.
     */
    fallbackModels?: string[];
    skipPermissions?: boolean;
    permissionMode?: PermissionMode;
    /**
     * Apply a named permission preset instead of hand-combining
     * `permissionMode`, `skipPermissions`, `proxyTools`,
     * `extraDisallowedTools` and `controlRequestBehavior`.
     *
     * `"read-only"` makes the turn unable to change anything: no
     * `--dangerously-skip-permissions` (the CLI refuses bypass under
     * `--restricted` outright), `--restricted` so the CLI has no Bash, REPL or
     * WebFetch at all, the mutating built-ins on `--disallowedTools` for CLIs
     * too old for that flag, the write and command tools removed from the
     * opencode proxy, and every remaining permission request denied.
     *
     * A preset overrides those five options rather than merging with them, so
     * one setting decides the posture; the plugin warns about each value it
     * drops. Unset (the default) changes nothing.
     */
    permissionPreset?: PermissionPreset;
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
     * opencode tools to forward through the proxy by name, on top of the
     * built-in `proxyTools` defs. Empty by default.
     *
     * MCP-backed opencode tools are already routed automatically (see
     * `proxyOpencodeMcpTools`), but that match is `<server>` or
     * `<server>_<tool>`, so a tool another opencode plugin declares directly
     * belongs to no server and is never offered to Claude. opencode-dcp's
     * `compress` is the motivating case: dcp injects "MAX CONTEXT LIMIT
     * REACHED ... You MUST use the `compress` tool now" reminders that the
     * model could not act on, because the tool was never in its list.
     *
     * Names are opencode's tool ids as `client.tool.list()` reports them
     * (matched case-insensitively): `["compress"]`. An unknown name is
     * skipped with a warning. This is an explicit allowlist and never
     * automatic: a forwarded tool executes inside opencode with the calling
     * agent's permissions.
     *
     * A name already held by a proxy def is NOT taken over. Listing
     * `"compress"` here while `proxyTools` also contains `"Compress"` leaves
     * the plugin's own in-process compress in charge and drops the forwarded
     * one with a warning, because the two do different things: the plugin's
     * resets the Claude Code session, opencode's compresses opencode's
     * transcript. Pick one.
     */
    proxyOpencodeTools?: string[];
    /**
     * Remove `<dcp-system-reminder>` blocks from message text when no
     * `compress` tool is being proxied. Off by default.
     *
     * opencode-dcp anchors those reminders into messages, so they are re-sent
     * with every message that carries one. When compress is not reachable
     * they are an instruction the model cannot follow, and the plugin already
     * tells it to ignore them in the appended system prompt. Turning this on
     * stops paying for them as well. It is inert whenever `compress` is
     * proxied (via either `proxyTools` or `proxyOpencodeTools`), since the
     * reminder is then something the model can actually act on.
     */
    stripContextReminders?: boolean;
    /**
     * Extra Claude Code built-ins to switch off with `--disallowedTools`,
     * on top of the ones implied by `proxyTools`.
     *
     * `proxyTools` can only disable built-ins the plugin knows how to
     * replace, so a built-in with no proxy equivalent (`NotebookEdit`, and
     * anything Claude Code adds after this release) has no off switch
     * otherwise. Names are Claude's, not opencode's: `["NotebookEdit"]`.
     *
     * Disabling a tool with no replacement removes the capability rather
     * than routing it through opencode — that is the point, but it does mean
     * the model has to work without it.
     */
    extraDisallowedTools?: string[];
    /**
     * Per-tool proxy call timeouts in milliseconds, keyed by the proxy tool
     * name (`bash`, `edit`, `write`, `webfetch`, `task`, `question` —
     * case-insensitive). When a proxied tool call waits longer than its
     * deadline for opencode to resolve it, the call is rejected and Claude
     * receives a timeout error.
     *
     * Defaults (used when a tool is absent here): `bash`/`edit`/`write`/
     * `webfetch` → 10 min (matches Claude CLI's Bash ceiling); `task` and
     * `task_batch` → no deadline (the call waits for the subagent; abandoned
     * calls are released by aborts, the next user turn, and the process going
     * away); `question` → 30 min (operator AFK). A positive value here replaces
     * the default for that tool, `0` disables its deadline, and a negative or
     * non-finite value is ignored.
     *
     * For `bash` specifically the call's own `input.timeout` is honoured on
     * top: the effective deadline is `max(resolved, input.timeout)`, so a
     * long build the caller explicitly asked to run is never undercut, and a
     * positive `input.timeout` restores a deadline that `bash: 0` disabled.
     */
    proxyToolTimeoutMs?: Record<string, number>;
    /**
     * Route Claude's `ExitPlanMode` through opencode's native `question` tool.
     *
     * Off (default): the plan is rendered as markdown followed by
     * `**Do you want to proceed with this plan?** (yes/no)` and the operator
     * answers in prose. On: the plan is rendered, the turn ends on
     * `tool-calls`, and opencode runs its own `question` tool so approval is a
     * real form; the answer is fed back to the CLI as the `tool_result` for
     * the original `ExitPlanMode` call, which is what unlocks plan mode.
     *
     * Opt-in, and currently dormant. The delivery surface works: opencode's
     * `question` form renders and round-trips (verified 2026-09-06, correcting
     * an earlier claim here that it was broken upstream). What does not work is
     * the trigger: headless `--print` does not offer the model an
     * `ExitPlanMode` tool, measured on CLI 2.1.258, so the bridge has nothing
     * to key on and the text path is what you get. Older opencode builds also
     * have no `question` registry entry, in which case the plugin silently
     * keeps the text path. Re-run the probes in AGENTS.md on a newer CLI before
     * assuming the bridge is reachable.
     */
    planModeQuestion?: boolean;
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
     * Kill a retained headless Claude worker after this many milliseconds of
     * inactivity following a completed turn. Off unless set. The timer
     * starts when a turn completes (not at spawn), starting another turn cancels
     * it, a worker found mid-turn when it fires is left alone and re-timed, and
     * the Claude session id is retained for a transparent resume. Omit or set 0
     * to keep workers until LRU eviction (16 processes). Interactive transport is
     * excluded because it does not currently guarantee session-id resume.
     */
    idleProcessTimeoutMs?: number;
    /**
     * Expose your opencode skills to Claude Code's native Skill tool by staging
     * them as a session-scoped `--plugin-dir`, so a `Skill("<name>")` call for a
     * skill opencode advertises does not fail with `Unknown skill`. Covers every
     * root opencode itself reads: project `.opencode/`, `.claude/` and `.agents/`
     * walking up from the workspace, the opencode config dirs, and the global
     * `~/.claude/skills` and `~/.agents/skills` (those last two behind the same
     * `OPENCODE_DISABLE_EXTERNAL_SKILLS` / `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`
     * switches opencode honours).
     *
     * Off by default: every bridged skill is also listed in the system prompt
     * opencode forwards, so a large skill set costs prompt tokens twice per turn.
     * When on it applies to the headless, interactive and direct `doGenerate`
     * spawns alike; compaction never loads it, and the bundled configuration
     * skill is staged either way. No-op on CLIs without `--plugin-dir`.
     */
    bridgeOpencodeSkills?: boolean;
    /**
     * Leave a skill unbridged when the Claude Code session already loads it:
     * from `<CLAUDE_CONFIG_DIR>/skills` (`~/.claude/skills` by default), from the
     * project's own `.claude/skills`, or from an installed plugin's `skills/`.
     * On by default, because those roots overlap opencode's and the duplicate
     * costs prompt tokens on every turn for nothing.
     *
     * A skill is treated as already loaded when it is literally the same
     * directory (symlinks resolved), when its SKILL.md is byte-identical to a
     * native one, or when a *different* skill of the same name is registered
     * under user or project scope. That last case is the only one that changes
     * behaviour, because `Skill("<name>")` then answers from Claude's copy
     * rather than opencode's, so it is logged at WARN naming both paths. Plugin
     * skills are namespaced `<plugin>:<name>` and so only ever match by content.
     *
     * Set `false` to bridge everything regardless, which restores the pre-0.25
     * behaviour of advertising a shared skill twice.
     */
    bridgeSkipNativeSkills?: boolean;
    /**
     * Append one compact line to the end of every finished (non-compaction,
     * non-error) turn with what that turn cost: dollars, wall duration, how many
     * internal CLI turns it took, and input / output / cache-read / cache-write
     * tokens. It is rendered as its own text part led by `▌ **stats:**` and is
     * stripped again from any transcript rebuilt for the CLI, so the model never
     * reads its own accounting.
     *
     * Off by default, because a cost line under every reply is a preference.
     * The same numbers are logged at INFO regardless of this setting, and
     * `total_cost_usd`, `duration_ms`, `usage`, `modelUsage` and
     * `permission_denials` always reach `providerMetadata`.
     */
    turnStats?: boolean;
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
     * tool-call) and the session id is preserved for `--resume` so the conversation
     * continues seamlessly. Defaults to `true`.
     *
     * Set to `false` to keep the previous behavior (cached subprocess
     * survives MCP changes until the chat is reset).
     */
    hotReloadMcp?: boolean;
    /**
     * Route opencode MCP server tools through the in-process `opencode_proxy`
     * MCP server instead of bridging them directly into Claude CLI's
     * `--mcp-config`. Routing through the proxy keeps a single execution site
     * (opencode), so the call is permission-prompted and rendered as an
     * opencode tool call instead of running inside Claude CLI's own MCP child.
     *
     * Defaults to `false`, and that is a change of default rather than of
     * behaviour. It used to default to `true` while routing nothing at all:
     * discovery read `client.tool.list()`, which enumerates opencode's tool
     * registry (built-ins plus plugin-declared tools) and has never contained
     * an MCP tool, so no def was ever built. Discovery now reads the model tool
     * set opencode passes the provider, which is where MCP tools actually live,
     * so the option works. Leaving it on by default would then have silently
     * moved every existing user's MCP traffic off the direct bridge that is
     * carrying it today, so switching over is the operator's call.
     *
     * Two things to know before enabling it:
     *
     * - It only affects the servers this plugin bridges. If the same server is
     *   also registered in Claude Code's own config, Claude reaches it directly
     *   and the proxy is bypassed. Pair this with `strictMcpConfig: true` so
     *   Claude sees only the config this plugin writes.
     * - A routed call executes inside opencode with the calling agent's
     *   permissions, the same trade `proxyOpencodeTools` makes.
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
/**
 * A named bundle of permission settings, so a safety posture is one option
 * instead of a hand-rolled combination of `permissionMode`, `skipPermissions`,
 * `proxyTools`, `extraDisallowedTools` and `controlRequestBehavior`. Opt-in:
 * unset means today's behaviour, unchanged.
 *
 * `read-only` is the only preset so far. See `src/permission-presets.ts` for
 * what it resolves to and why each part is needed.
 */
type PermissionPreset = "read-only";
/**
 * The `permissionMode` a resolved preset puts on `ClaudeCodeConfig`.
 * Plugin-internal, never a value the operator sets: `buildCliArgs` translates
 * `"read-only"` into `--restricted` (plus `--permission-prompts none` where
 * the CLI has it) rather than passing it to `--permission-mode`, which would
 * reject it.
 */
declare const READ_ONLY_PERMISSION_MODE = "read-only";
type EffectivePermissionMode = PermissionMode | typeof READ_ONLY_PERMISSION_MODE;
type ControlRequestBehavior = "allow" | "deny";
/**
 * `Question` is deliberately absent: enabling it disables Claude Code's
 * built-in AskUserQuestion (via --disallowedTools) and replaces the
 * stop-and-wait deny/markdown path with an in-turn blocking form. That is a
 * behavior trade against the issue-#8 guarantee, so it stays opt-in until it
 * has the same live mileage Task had before v0.10.0 flipped it on. Users opt
 * in by listing it in `proxyTools`; see README "Question proxy tool".
 *
 * It lives here rather than in `index.ts` (which still re-exports it, so the
 * public name is unchanged) because `permission-presets.ts` needs it to say
 * which proxy tools a preset dropped, and `startup-diagnostics.ts` and
 * `doctor.ts` read that answer. Importing `index.ts` from any of the three
 * would be a cycle.
 */
declare const DEFAULT_PROXY_TOOL_NAMES: string[];
/**
 * Claude CLI stream-json message types.
 */
interface ClaudeStreamMessage {
    type: string;
    subtype?: string;
    request_id?: string;
    fast_mode_state?: "on" | "off" | "cooldown";
    fast_mode_disabled_reason?: string;
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
    /**
     * On an `assistant` message the CLI synthesised to report a failure: the
     * kind of failure (`authentication_failed`, `billing_error`, ...). Read by
     * `accountBlockKind`; schema confirmed on Claude Code 2.1.280.
     */
    error?: string;
    /** On a `conversation_reset`: the conversation Claude Code started. */
    new_conversation_id?: string;
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
            /** On a `tool_result` block: the CLI-executed tool failed. */
            is_error?: boolean;
        }>;
        /** On an `assistant` frame: that one API call's usage, not the turn's. */
        usage?: ClaudeStreamMessage["usage"];
    };
    apiKeySource?: string;
    permissionMode?: string;
    model?: string;
    claude_code_version?: string;
    tools?: string[];
    mcp_servers?: Array<{
        name?: string;
        status?: string;
    }>;
    /**
     * `--mcp-config` entries the CLI refused to load. Omitted entirely when
     * there are none, and an affected server is absent from `mcp_servers` too,
     * which is why it needs its own field: a skipped server is invisible in the
     * list. See `parseMcpServerErrors` in `cli-events.ts`.
     */
    mcp_server_errors?: Array<{
        name?: string;
        type?: string;
        message?: string;
    }>;
    compact_metadata?: Record<string, unknown>;
    compactMetadata?: Record<string, unknown>;
    rate_limit_info?: Record<string, unknown>;
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
    stop_reason?: string | null;
    /**
     * Per-model totals on `result`, keyed by model id: `inputTokens`,
     * `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`,
     * `webSearchRequests`, `costUSD`. All numeric, which is what makes it safe
     * to forward whole into `providerMetadata`.
     */
    modelUsage?: Record<string, Record<string, number>>;
    /**
     * Tool calls the CLI's permission layer refused during the turn. Each entry
     * also carries a `tool_input` on the wire; it is deliberately not declared
     * here, because it can be a whole file's contents and must not be copied
     * into provider metadata.
     */
    permission_denials?: Array<{
        tool_name?: string;
        tool_use_id?: string;
    }>;
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

/**
 * Named permission presets: one option that decides a safety posture, instead
 * of the operator hand-combining `permissionMode`, `skipPermissions`,
 * `proxyTools`, `extraDisallowedTools` and `controlRequestBehavior` and
 * getting one of them wrong.
 *
 * Opt-in. No preset resolves to exactly today's behaviour, byte for byte.
 *
 * ## Why `read-only` is not just a CLI flag
 *
 * Claude Code 2.1.248 added `--restricted`, which removes the built-in tools
 * that run commands or code plus WebFetch, confines the file tools to the
 * working directories, and refuses bypassPermissions. That covers the CLI's
 * own tools and nothing else, and this plugin's whole point is that it puts a
 * second execution path next to them: `proxyTools` defaults to `Bash`, `Edit`,
 * `Write`, `WebFetch` and `Task`, each an MCP tool the CLI calls and opencode
 * executes. `--restricted` never sees those. So the preset has to work at
 * three layers at once:
 *
 *   1. the CLI's own tools (`--restricted`, plus `--disallowedTools` for the
 *      same names so a CLI too old for `--restricted` still refuses them),
 *   2. the opencode proxy (the mutating defs are dropped before the proxy
 *      server is built, so they are never offered),
 *   3. everything left that would prompt (denied, because a bridged MCP
 *      server or a file tool reaching outside the cwd is neither of the
 *      above).
 *
 * ## Measured, on the CLI this was written against (2.1.280)
 *
 * `--restricted --dangerously-skip-permissions` is a hard startup error,
 * `Error: bypassPermissions not supported in restricted mode`, so dropping
 * the skip flag is a correctness requirement and not hygiene. In the binary,
 * `restrictedMode` is a `bypassImmune` circuit breaker, which is the same
 * fact from the other side. A `--restricted` run asked to write a file and
 * run a command reported one `permission_denials` entry (`Write`) and no Bash
 * attempt at all: the shell tool was not in the set to begin with.
 */

/** The options a preset decides, resolved. */
interface ResolvedPermissionPreset {
    preset: PermissionPreset;
    permissionMode: EffectivePermissionMode;
    skipPermissions: boolean;
    proxyTools: string[];
    extraDisallowedTools: string[];
    controlRequestBehavior: ControlRequestBehavior;
    /** Always undefined under a preset: see `overridden` below. */
    controlRequestToolBehaviors: undefined;
    /**
     * Operator-set values the preset replaced, as `option: reason` lines, so
     * the caller can warn once per option rather than silently winning.
     */
    overridden: string[];
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
    /**
     * Whether this call only names the session, which gets the synthetic stub
     * rather than a `claude` spawn. See `isTitleRequest` in title.ts.
     */
    private isTitleRequest;
    private requestScope;
    /**
     * Build the combined `--mcp-config` list and return both the list and the
     * hash of the bridged opencode MCP block. See `effectiveMcpConfig` in
     * spawn-planning.ts.
     */
    private effectiveMcpConfig;
    /** Resolve ProxyToolDef[] for the configured proxyTools names. */
    private resolvedProxyTools;
    /** Resolve ProxyToolDef[] for opencode's MCP-backed tools. */
    private resolvedProxyMcpTools;
    /** One `client.tool.list()` fetch, shaped for this turn's gates. */
    private fetchLiveToolInfo;
    /**
     * Whether dcp-style context reminders should be stripped from this turn's
     * messages. Config-only and synchronous, so it can be answered before the
     * spawn block resolves anything: `userMsg` is built well ahead of it.
     */
    private stripContextRemindersEnabled;
    /**
     * Arguments the skill bridge needs beyond `cwd` / `cliPath`: which
     * `CLAUDE_CONFIG_DIR` this spawn reads its native skills from, and whether
     * to drop the ones it already loads.
     */
    private skillBridgeSpawn;
    /** Share one lazy registry request within a turn without making it stale. */
    private createLiveToolInfoLoader;
    /**
     * Whether the ExitPlanMode approval bridge is live for this turn: the
     * operator opted in AND opencode's registry actually has the `question`
     * tool. Without the registry entry the emitted tool-call would render as
     * `⚙ invalid` and wedge the turn, so the plugin keeps the text path.
     */
    private resolvePlanModeQuestion;
    /**
     * Create a proxy MCP server for a single active Claude process/session.
     * The process lifecycle owns the server lifecycle via session-manager.
     */
    private ensureProxyServer;
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
    private doGenerateViaStream;
    /**
     * One turn implementation serves both host methods, so this is `doStream`
     * aggregated. The host's tool vocabulary is applied inside `streamTurn`,
     * which is why nothing is renamed here.
     */
    doGenerate(options: LanguageModelV3CallOptions): Promise<Awaited<ReturnType<LanguageModelV3["doGenerate"]>>>;
    /**
     * Tool parts leave in opencode 1.x's vocabulary; on opencode 2.x they are
     * renamed at this one edge (src/host-tools.ts). On V1 the stream is
     * returned untouched.
     */
    doStream(options: LanguageModelV3CallOptions): Promise<Awaited<ReturnType<LanguageModelV3["doStream"]>>>;
    /**
     * The turn, for both host methods. `mode` is documented on `TurnMode`; it is
     * threaded down to `doStreamForHost` rather than read from the call options,
     * because which method opencode used is not in them.
     */
    private streamTurn;
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
    private runModelChain;
    private doStreamForHost;
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

type AgentRecord = {
    mode?: string;
    /** A fully-qualified `provider/model` the agent pinned for itself. */
    model?: string;
    /** Model NAME this agent wants, on whatever account the caller is using. */
    forceModel?: string;
    /** Thinking budget this agent wants, whatever the caller's picker says. */
    reasoningEffort?: string;
    /**
     * Prompt cache TTL for this agent's own `claude` process, `5m` or `1h`.
     * See `resolveAgentCacheTtl` for why this is a main-conversation setting
     * and not the CLI's per-agent `experimental.cacheTtl`.
     */
    cacheTtl?: string;
    /**
     * Models to try, in order, when the one this agent would have run is
     * refused. Same account throughout; see `src/model-fallback.ts`.
     */
    fallbackModels?: string[];
};
declare function getAgentRegistry(): Record<string, AgentRecord>;
declare function getDefaultSubagentModel(): string | undefined;
/**
 * The model a request should actually spawn with.
 *
 * Order, first match wins:
 *   1. The agent declared `forceModel`.
 *   2. The agent is a discovered subagent and `defaultSubagentModel` is set.
 *   3. Anything else: the id opencode asked for, untouched.
 *
 * An agent that pinned a full `provider/model` is out of scope entirely:
 * opencode already routed the call to that provider, and second-guessing it
 * here would silently undo a choice the user made explicitly.
 *
 * Fails closed. An id that is not in the model registry is refused and the
 * original kept, because the alternative is spawning the CLI with a `--model`
 * it will reject, on a turn someone is waiting for.
 */
declare function resolveAgentModel(agent: string | undefined, modelId: string, overrides?: {
    records?: Record<string, AgentRecord>;
    defaultSubagentModel?: string;
}): string;

declare const defaultModels: Record<string, OpenCodeModel>;

interface ClaudeCodeProvider {
    specificationVersion: "v3";
    (modelId: string): LanguageModelV3;
    languageModel(modelId: string): LanguageModelV3;
}

/**
 * Registers `/btw` unless the user defined their own. Returns whether the
 * registration is ours: the command hook only intercepts `btw` in that case,
 * so a user-defined command keeps opencode's normal behaviour end to end.
 */
declare function registerSideQuestionCommand(config: OpenCodeConfig): boolean;
/**
 * Registers `/claude-code-doctor` unless the user defined their own command of
 * that name. Unlike `/btw` there is no hook to guard: the command is a plain
 * template and the language model answers the message it produces, so leaving
 * a user definition alone here is the whole guard.
 *
 * The name carries no slash. opencode invokes a command as `/<key>` and takes
 * everything after the first space as `$ARGUMENTS`, so `claude-code doctor`
 * would be the command `claude-code` with the argument `doctor`.
 */
declare function registerDoctorCommand(config: OpenCodeConfig): boolean;
declare function _resetPlanModeWarningForTests(): void;
declare function warnIfPlanModeCannotExit(permissionMode: string | undefined): void;
/**
 * Resolve `permissionPreset` for this provider, reporting what it replaced.
 *
 * The result is applied over the operator's settings by `createClaudeCode`,
 * which is the one funnel both opencode majors reach the language model
 * through, so a preset needs wiring in exactly one place.
 *
 * Every override is logged at NOTICE, and an unrecognised preset name is a
 * WARN plus no preset at all. A safety option must never be approximated: a
 * typo'd `"readonly"` silently running at full permissions is worse than one
 * that says so.
 */
declare function applyPermissionPreset(settings: ClaudeCodeProviderSettings, defaultProxyTools: readonly string[]): ResolvedPermissionPreset | null;
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
/**
 * Record what every known agent asked for, so `resolveAgentModel` and
 * `resolveAgentEffort` can answer at spawn time without the language model
 * needing to see opencode's config.
 *
 * Runs BEFORE `expandAccountProviders`, which deletes the seed provider entry
 * once it has expanded it: `defaultSubagentModel` has to be read while it is
 * still there.
 *
 * Purely observational. It defines no agents and changes no agent's config;
 * an agent this plugin never heard of is simply absent from the registry,
 * which is what keeps opencode's built-ins out of the override path.
 */
declare function buildAgentRegistry(config: OpenCodeConfig): Promise<void>;
/**
 * The opencode session id a `session.deleted` bus event names, or undefined
 * for any other event. opencode publishes `{ type, properties: { info } }`
 * under `payload`, and the deleted session's own record is `properties.info`.
 */
declare function extractDeletedSessionId(event: OpenCodeEvent | undefined): string | undefined;
declare const _default: {
    id: string;
    server: OpenCodePlugin;
    setup: (ctx: V2Context) => Promise<V2Cleanup>;
};

export { type AgentRecord, type ClaudeCodeConfig, ClaudeCodeLanguageModel, type ClaudeCodeProvider, type ClaudeCodeProviderSettings, type ClaudeStreamMessage, DEFAULT_PROXY_TOOL_NAMES, type OpenCodeHooks, type OpenCodeModel, type OpenCodePlugin, _resetPlanModeWarningForTests, applyPermissionPreset, bridgeOpencodeMcp, buildAgentRegistry, claudeCodeProviders, configModelsForProvider, createClaudeCode, _default as default, defaultModels, extractDeletedSessionId, getAgentRegistry, getDefaultSubagentModel, registerDoctorCommand, registerSideQuestionCommand, resolveAgentModel, warnIfPlanModeCannotExit };
