/**
 * omp event handlers wiring the DCP pipeline into the live session.
 *
 * `createContextMenuHandler` is the heart: every provider request it rebuilds
 * tool metadata, runs the strategies, assigns m-refs, prunes, injects the DCP
 * system block, and nudges — on a clone of the messages, never touching
 * storage.
 */

import type { AgentMessage, ExtensionAPI, ContextEvent, ExtensionContext, SessionEntry } from "./omp";
import type { PluginConfig } from "./config";
import type { Logger } from "./logger";
import type { SessionState } from "./state/types";
import { resetForSession } from "./state/state";
import { loadSessionState, saveSessionState } from "./state/persistence";
import { buildToolMetadata, countUserTurns } from "./messages/query";
import { assignMessageRefs } from "./messages/identity";
import { prune } from "./messages/prune";
import { injectCompressNudges } from "./messages/nudge";
import { deduplicate } from "./strategies/deduplication";
import { purgeErrors } from "./strategies/purge-errors";
import { estimateMessagesTokens } from "./token-utils";
import { SYSTEM_PROMPT_BLOCK } from "./prompts";

export interface HandlerDeps {
  state: SessionState;
  logger: Logger;
  config: PluginConfig;
  pi: ExtensionAPI;
  counters: { contextFetch: number };
}

/**
 * Inject the DCP system-prompt block into the LLM-bound message stream.
 *
 * Upstream OpenCode re-injects its DCP system block on every provider request
 * via `experimental.chat.system.transform`. omp has no system-transform hook,
 * so we do the faithful equivalent here: prepend the block on the `context`
 * event's copy on every pass. LLM-only (the context event is never written to
 * storage or the display transcript), and it survives omp's own compaction —
 * which would otherwise wipe any once-per-session guidance.
 *
 * Role: `developer` (NOT `system`). omp's `convertToLlm`/`convertOne` has no
 * `system` case — a system-role message silently falls through the `default`
 * branch and is dropped before reaching the provider. `developer` is preserved
 * (`convertMessageToLlm` case "developer") and maps to the system slot on
 * Anthropic/OpenAI-compatible providers. `user` would also survive but reads
 * as a user turn; `developer` is the faithful system-slot analogue.
 *
 * Idempotent: skips when a message with the same role is already present.
 * Returns the possibly-new array.
 */
export function injectSystemPrompt(messages: AgentMessage[]): AgentMessage[] {
  const existing = messages.find((m) => m.role === "developer");
  if (existing) return messages; // DCP guidance already present; nothing to add
  return [
    { role: "developer", content: [{ type: "text", text: SYSTEM_PROMPT_BLOCK }] },
    ...messages,
  ];
}

function isCompactionEntry(e: SessionEntry): boolean {
  return (e as { type?: string }).type === "compaction";
}

function latestCompactionTimestamp(entries: SessionEntry[]): number {
  let latest = 0;
  for (const e of entries) {
    if (isCompactionEntry(e)) {
      const t = Date.parse((e as { timestamp?: string }).timestamp ?? "");
      if (Number.isFinite(t) && t > latest) latest = t;
    }
  }
  return latest;
}

/** If omp ran its own compaction since our last pass, our compression blocks reference gone messages — reset them. */
function reconcileOmpCompaction(deps: HandlerDeps, entries: SessionEntry[]): void {
  const latest = latestCompactionTimestamp(entries);
  if (latest > 0 && latest > deps.state.lastCompaction) {
    deps.logger.info("omp compaction detected; clearing DCP compression state", { latest, prev: deps.state.lastCompaction });
    deps.state.prune.messages = {
      byMessageId: new Map(),
      blocksById: new Map(),
      activeBlockIds: new Set(),
      activeByAnchorMessageId: new Map(),
      nextBlockId: 1,
      nextRunId: 1,
    };
    deps.state.prune.tools = new Map();
    deps.state.lastCompaction = latest;
  }
}

function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
  // Deep-clone each message and its content blocks: prune / assignMessageRefs /
  // nudge mutate block fields in place (block.text, block.content, tool_use
  // input). omp may reuse block objects across calls, so we must not touch the
  // originals — storage stays byte-for-byte intact.
  return messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content) ? m.content.map((b) => structuredClone(b)) : m.content,
  }));
}

export function createContextMenuHandler(deps: HandlerDeps) {
  return (event: ContextEvent, ctx: ExtensionContext): { messages: AgentMessage[] } | void => {
    if (!deps.config.enabled) return;
    if (deps.state.isSubAgent && !deps.config.experimental.allowSubAgents) return;

    if (event.model?.contextWindow) {
      deps.state.modelContextLimit = event.model.contextWindow;
    }

    const entries = ctx.sessionManager?.getBranch?.() ?? [];
    reconcileOmpCompaction(deps, entries);

    const messages = cloneMessages(event.messages ?? []);

    buildToolMetadata(deps.state, messages);
    deps.state.currentTurn = countUserTurns(messages);

    // strategies recompute transient prune.tools each pass
    deps.state.prune.tools = new Map();
    deduplicate(deps.state, deps.config, deps.logger);
    purgeErrors(deps.state, deps.config, deps.logger);

    assignMessageRefs(deps.state, messages);
    const pruned = prune(deps.state, deps.logger, deps.config, messages);
    // Stash the POST-prune array: it is exactly what the model sees, so the
    // content anchors the model quotes match what the compress tool resolves.
    deps.state.lastContextMessages = pruned;

    deps.counters.contextFetch += 1;
    injectCompressNudges(deps.state, deps.config, estimateMessagesTokens(pruned), pruned, deps.counters.contextFetch);

    // Per-request system guidance (upstream parity): always present in the
    // LLM-bound stream, never persisted, immune to omp compaction.
    const withSystem = injectSystemPrompt(pruned);

    deps.logger.saveContext(deps.state.sessionId ?? "session", withSystem);
    return { messages: withSystem };
  };
}

export function createSessionStartHandler(deps: HandlerDeps) {
  return (event: { sessionId?: string }, ctx: ExtensionContext): void => {
    if (!deps.config.enabled) return;

    const sessionId = event.sessionId ?? ctx.sessionManager?.getSessionFile?.() ?? null;
    if (deps.state.sessionId && deps.state.sessionId !== sessionId) {
      resetForSession(deps.state, sessionId ?? "");
    }
    deps.state.sessionId = sessionId ?? deps.state.sessionId;
    deps.counters.contextFetch = 0;

    const entries = ctx.sessionManager?.getBranch?.() ?? [];
    loadSessionState(entries, deps.state);
    deps.state.lastCompaction = latestCompactionTimestamp(entries);
  };
}

export function createTurnEndHandler(deps: HandlerDeps) {
  return (event: { model?: { contextWindow?: number } }): void => {
    if (event.model?.contextWindow) deps.state.modelContextLimit = event.model.contextWindow;
  };
}

export { saveSessionState };
