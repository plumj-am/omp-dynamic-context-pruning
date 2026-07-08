/**
 * omp event handlers wiring the DCP pipeline into the live session.
 *
 * `createContextMenuHandler` is the heart: every provider request it rebuilds
 * tool metadata, runs the strategies, assigns m-refs, prunes, and nudges — on a
 * clone of the messages, never touching storage.
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
  systemInjectedFor: string | null;
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
    // Stash the POST-prune array: it is exactly what the model sees, so
    // positional range citation (m0001 = oldest visible message) aligns with
    // what the compress tool resolves.
    deps.state.lastContextMessages = pruned;

    deps.counters.contextFetch += 1;
    injectCompressNudges(deps.state, deps.config, estimateMessagesTokens(pruned), pruned, deps.counters.contextFetch);

    deps.logger.saveContext(deps.state.sessionId ?? "session", pruned);
    return { messages: pruned };
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

    // one-time DCP orientation message
    if (deps.config.compress.permission !== "deny" && sessionId && deps.systemInjectedFor !== sessionId) {
      deps.systemInjectedFor = sessionId;
      try {
        deps.pi.sendCustomMessage?.(
          { customType: "dcp-system", content: SYSTEM_PROMPT_BLOCK, display: false, attribution: "agent" },
          { deliverAs: "nextTurn" },
        );
      } catch {
        /* best-effort */
      }
    }
  };
}

export function createTurnEndHandler(deps: HandlerDeps) {
  return (event: { model?: { contextWindow?: number } }): void => {
    if (event.model?.contextWindow) deps.state.modelContextLimit = event.model.contextWindow;
  };
}

export { saveSessionState };
