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
  const hasWork =
    messagesState.byMessageId.size > 0 || messagesState.activeByAnchorMessageId.size > 0;
  if (!hasWork) return messages;

  const identities = computeIdentities(messages, state.isSubAgent);
  const result: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const identity = identities[i];

    // If this message is an anchor for an active summary, inject the summary.
    if (identity) {
      const blockId = messagesState.activeByAnchorMessageId.get(identity);
      const block = blockId !== undefined ? messagesState.blocksById.get(blockId) : undefined;
      if (block) {
        if (!block.active || typeof block.summary !== "string" || block.summary.length === 0) {
          logger.warn("Skipping malformed compress summary", { anchorMessageId: identity, blockId });
        } else {
          const anchorPruned = isMessageCompacted(state, identity);
          if (anchorPruned) {
            // anchor is inside the compressed range: replace it with the summary
            result.push(syntheticSummary(block.summary));
          } else {
            // anchor precedes the range: prepend the summary, keep the message
            result.push(prependSummary(msg, block.summary));
          }
          logger.debug("Injected compress summary", { anchorMessageId: identity });
        }
      }
    }

    // Drop messages that belong to an active compression block.
    if (identity && isMessageCompacted(state, identity)) continue;

    result.push(msg);
  }

  return result;
}

function syntheticSummary(summary: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: summary } satisfies ContentBlock],
  };
}

function prependSummary(msg: AgentMessage, summary: string): AgentMessage {
  // shallow clone + new content array so we never mutate the shared message
  const clone: AgentMessage = { ...msg, content: [{ type: "text", text: summary } satisfies ContentBlock, ...(Array.isArray(msg.content) ? msg.content : [])] };
  return clone;
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
