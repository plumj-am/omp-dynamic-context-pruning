/**
 * Ambient declarations for the Oh My Pi (omp) extension API surface that this
 * plugin depends on. Sourced from the omp internal docs
 * (omp://extensions.md, omp://hooks.md, omp://session.md, omp://sdk.md).
 *
 * These exist so the plugin type-checks standalone; at runtime omp resolves
 * `@oh-my-pi/pi-coding-agent` to its host-bundled copy and the `ExtensionAPI`
 * is injected into the factory.
 *
 * Only the surfaces actually used by this plugin are declared.
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  /** Provider-assigned, globally unique, persisted tool-call id. */
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: ToolResultContent | ToolResultContent[];
  is_error?: boolean;
}

export type ToolResultContent = TextBlock | { type: "image"; source: unknown } | string;

export interface ThinkingBlock {
  type: "thinking";
  thinking?: string;
  text?: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | Record<string, unknown>;

export interface MessageUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "custom" | string;
  content: ContentBlock[];
  provider?: string;
  model?: string;
  usage?: MessageUsage;
  timestamp?: number;
  customType?: string;
  // omp allows arbitrary passthrough fields; keep an index for safe access.
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Session entries (ctx.sessionManager.getBranch())
// ---------------------------------------------------------------------------

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data: unknown;
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | ContentBlock[];
  display?: boolean;
  attribution?: "user" | "agent";
}

export type SessionEntry = SessionEntryBase | MessageEntry | CustomEntry | CustomMessageEntry;

export interface SessionManager {
  getBranch(): SessionEntry[];
  getSessionFile(): string | undefined;
}

// ---------------------------------------------------------------------------
// Extension contexts
// ---------------------------------------------------------------------------

export interface ExtensionUIContext {
  notify(message: string, level?: "info" | "warn" | "error"): void;
  setStatus?(key: string, text: string): void;
}

export interface ExtensionContext {
  ui: ExtensionUIContext;
  hasUI: boolean;
  cwd: string;
  sessionManager: SessionManager;
  model?: { id?: string; contextWindow?: number };
  getContextUsage?(): { tokens?: number; limit?: number };
  isIdle(): boolean;
}

export interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
  reload(): Promise<void>;
}

export interface ToolExecuteContext {
  signal?: AbortSignal;
  onUpdate?(chunk: { content: unknown[] }): void;
}

export interface ToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  hidden?: boolean;
  defaultInactive?: boolean;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ToolExecuteContext["onUpdate"],
    ctx: ExtensionContext,
  ): Promise<ToolResult>;
  onSession?(event: { reason: string }, ctx: ExtensionContext): void;
}

export interface ToolResult {
  content: ContentBlock[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface ContextEvent {
  messages: AgentMessage[];
  model?: { id?: string; contextWindow?: number };
}

export interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: unknown;
  content: ContentBlock[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface SessionStartEvent {
  sessionId?: string;
}

export interface TurnEndEvent {
  model?: { id?: string; contextWindow?: number };
}

// ---------------------------------------------------------------------------
// Zod-like schema (omp injects zod/v4)
// ---------------------------------------------------------------------------

export interface ZodSchema<T = unknown> {
  _def: unknown;
  _type?: T;
}

export interface ZodNamespace {
  string: (opts?: { description?: string }) => ZodSchema<string>;
  number: (opts?: { description?: string; min?: number }) => ZodSchema<number>;
  boolean: (opts?: { description?: string }) => ZodSchema<boolean>;
  array: <T>(schema: ZodSchema<T>) => ZodSchema<T[]>;
  object: <T extends Record<string, ZodSchema>>(shape: T) => ZodSchema<object>;
  enum: <T extends string>(values: readonly T[], opts?: { description?: string }) => ZodSchema<T>;
  optional: <T>(schema: ZodSchema<T>) => ZodSchema<T | undefined>;
}

// ---------------------------------------------------------------------------
// Extension API (injected into the default-exported factory)
// ---------------------------------------------------------------------------

export interface ExtensionAPI {
  zod: ZodNamespace;
  logger?: { debug?(...a: unknown[]): void; info?(...a: unknown[]): void; warn?(...a: unknown[]): void };

  setLabel(label: string): void;

  on(event: "context", handler: (event: ContextEvent, ctx: ExtensionContext) => Promise<{ messages?: AgentMessage[] } | void> | { messages?: AgentMessage[] } | void): void;
  on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> | void): void;
  on(event: "tool_result", handler: (event: ToolResultEvent, ctx: ExtensionContext) => Promise<Partial<ToolResult> | void> | Partial<ToolResult> | void): void;
  on(event: "turn_end", handler: (event: TurnEndEvent, ctx: ExtensionContext) => Promise<void> | void): void;
  on(event: "message_end", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
  on(event: string, handler: (...args: unknown[]) => unknown): void;

  registerTool(definition: ToolDefinition): void;

  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
    },
  ): void;

  /** Persist a non-LLM custom entry on the session (rebuilt from getBranch() on session_start). */
  appendEntry(customType: string, data: unknown): Promise<void> | void;

  /** Send a custom message to the session (omp's real API — `sendCustomMessage` does NOT exist). */
  sendMessage(message: { customType: string; content: string | ContentBlock[]; display?: boolean; details?: unknown; attribution?: "user" | "agent" }, options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean }): void;

  /** Package exports (full omp surface). */
  pi: Record<string, unknown>;
}
