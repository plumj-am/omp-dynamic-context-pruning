/**
 * Prune core — the heart of the context transform.
 *
 * Runs every provider request, on the LLM-facing message copy only:
 *   1. filterCompressedRanges — inject compression summaries at their anchors,
 *      drop messages that belong to an active compression block.
 *   2. pruneToolOutputs       — blank completed tool_result content for tool
 *      ids marked by the strategies (dedup / purge-errors).
 *   3. pruneToolErrors        — blank errored tool_use inputs.
 *
 * Storage is never touched. Ported from DCP `lib/messages/prune.ts`, adapted
 * to the omp content-block model and content-identity keys.
 */

import type { AgentMessage, ContentBlock, ToolResultBlock } from "../omp";
import type { SessionState } from "../state/types";
import type { PluginConfig } from "../config";
import type { Logger } from "../logger";
import { isMessageCompacted } from "../state/utils";
import { isToolUseBlock, isToolResultBlock } from "./shape";
import { computeIdentities } from "./identity";

const PRUNED_TOOL_OUTPUT_REPLACEMENT =
  "[Output removed to save context - information superseded or no longer needed]";
const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]";

/** Tools whose completed outputs we never blank (they carry intent/state). */
const OUTPUT_PROTECTED_TOOLS = new Set(["edit", "write", "ask", "question"]);

export function prune(state: SessionState, logger: Logger, config: PluginConfig, messages: AgentMessage[]): AgentMessage[] {
  const pruned = filterCompressedRanges(state, logger, messages);
  pruneToolOutputs(state, pruned);
  pruneToolErrors(state, pruned);
  return pruned;
}

function filterCompressedRanges(state: SessionState, logger: Logger, messages: AgentMessage[]): AgentMessage[] {
  const messagesState = state.prune.messages;
  if (messagesState.activeBlockIds.size === 0) return messages;

  const identities = computeIdentities(messages, state.isSubAgent);
  const identityToIndex = new Map<string, number>();
  for (let i = 0; i < identities.length; i++) {
    if (identities[i]) identityToIndex.set(identities[i], i);
  }

  const activeBlocks = [];
  for (const id of messagesState.activeBlockIds) {
    const block = messagesState.blocksById.get(id);
    if (block && block.active && typeof block.summary === "string" && block.summary.length > 0) {
      activeBlocks.push(block);
    }
  }
  if (activeBlocks.length === 0) return messages;

  // Identities elided by any active block (the original messages it covers).
  const elidedIds = new Set<string>();
  for (const block of activeBlocks) {
    for (const id of block.effectiveMessageIds) elidedIds.add(id);
  }

  // For each active block, inject its summary just before the earliest of its
  // effective messages still present in the current context. effective ids are
  // stable (original message identities), so this re-matches every pass.
  const injectBefore = new Map<string, number>(); // identity -> blockId
  for (const block of activeBlocks) {
    let earliest = Infinity;
    for (const id of block.effectiveMessageIds) {
      const idx = identityToIndex.get(id);
      if (idx !== undefined && idx < earliest) earliest = idx;
    }
    if (earliest !== Infinity) {
      const identityAtEarliest = identities[earliest];
      if (identityAtEarliest && !injectBefore.has(identityAtEarliest)) {
        injectBefore.set(identityAtEarliest, block.blockId);
      }
    } else {
      logger.warn("Compression block has no effective messages in context", { blockId: block.blockId });
    }
  }

  const result: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const identity = identities[i];
    if (identity && injectBefore.has(identity)) {
      const block = messagesState.blocksById.get(injectBefore.get(identity)!);
      if (block) {
        result.push(syntheticSummary(block.summary));
        logger.debug("Injected compress summary", { blockId: block.blockId });
      }
    }
    if (identity && elidedIds.has(identity)) continue; // elided by an active block
    result.push(messages[i]);
  }

  return result;
}

function syntheticSummary(summary: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: summary } satisfies ContentBlock],
  };
}

function pruneToolOutputs(state: SessionState, messages: AgentMessage[]): void {
  if (state.prune.tools.size === 0) return;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (!isToolResultBlock(block)) continue;
      if (!state.prune.tools.has(block.tool_use_id)) continue;
      // error outputs are handled by pruneToolErrors path; skip here
      if ("is_error" in block && (block as { is_error?: unknown }).is_error === true) continue;

      // find the tool name to honor OUTPUT_PROTECTED_TOOLS
      const toolName = findToolName(messages, block.tool_use_id);
      if (toolName && OUTPUT_PROTECTED_TOOLS.has(toolName)) continue;

      replaceToolResultContent(block, PRUNED_TOOL_OUTPUT_REPLACEMENT);
    }
  }
}

function pruneToolErrors(state: SessionState, messages: AgentMessage[]): void {
  if (state.prune.tools.size === 0) return;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!isToolUseBlock(block)) continue;
      if (!state.prune.tools.has(block.id)) continue;
      const meta = state.toolParameters.get(block.id);
      if (!meta || meta.status !== "error") continue;

      const input = block.input;
      if (input && typeof input === "object") {
        const obj = input as Record<string, unknown>;
        for (const key of Object.keys(obj)) {
          if (typeof obj[key] === "string") obj[key] = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT;
        }
      }
    }
  }
}

function findToolName(messages: AgentMessage[], toolUseId: string): string | undefined {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (isToolUseBlock(block) && block.id === toolUseId) return block.name;
    }
  }
  return undefined;
}

/** Replace a tool_result's content with a single placeholder text block. */
function replaceToolResultContent(block: ToolResultBlock, placeholder: string): void {
  block.content = [{ type: "text", text: placeholder }];
  if ("is_error" in block) delete (block as { is_error?: boolean }).is_error;
}
