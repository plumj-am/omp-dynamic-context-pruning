/**
 * Message-query helpers for the omp AgentMessage model:
 *  - turn counting and user-message lookup
 *  - tool-parameter metadata extraction (correlates tool_use ↔ tool_result)
 *  - "ignored" user-message detection (internal injections we skip for ref/id)
 */

import type { AgentMessage } from "../omp";
import type { ToolParameterEntry, SessionState } from "../state/types";
import { isToolUseBlock, isToolResultBlock, isErrorToolResult } from "./shape";
import { estimateBlockTokens } from "../token-utils";

/**
 * A user message we should neither cite (no m-ref) nor summarize past. omp
 * injects a few invisible/structural user turns (e.g. empty steering echoes,
 * compaction-continuation prompts). We treat empty user messages and those
 * carrying only whitespace as ignored.
 */
export function isIgnoredUserMessage(msg: AgentMessage): boolean {
  if (msg.role !== "user") return false;
  if (!Array.isArray(msg.content) || msg.content.length === 0) return true;
  // tool-result-only user messages are real (they carry tool output)
  let hasText = false;
  for (const b of msg.content) {
    if (typeof b === "object" && b !== null && "type" in b && (b as { type: unknown }).type === "text") {
      if (typeof (b as { text: unknown }).text === "string" && (b as { text: string }).text.trim().length > 0) hasText = true;
    }
  }
  // user message with tool_result blocks is never ignored
  for (const b of msg.content) if (isToolResultBlock(b)) return false;
  return !hasText;
}

/** Nearest preceding non-ignored user message at or before `upToIndex`. */
export function getLastUserMessage(messages: AgentMessage[], upToIndex: number): AgentMessage | null {
  for (let i = Math.min(upToIndex, messages.length - 1); i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user" && !isIgnoredUserMessage(msg)) return msg;
  }
  return null;
}

/** Index of the nearest preceding non-ignored user message. */
export function getLastUserMessageIndex(messages: AgentMessage[], upToIndex: number): number {
  for (let i = Math.min(upToIndex, messages.length - 1); i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user" && !isIgnoredUserMessage(msg)) return i;
  }
  return -1;
}

/**
 * Count user turns (non-ignored user messages). Used for purge-errors age and
 * iteration-nudge thresholds.
 */
export function countUserTurns(messages: AgentMessage[]): number {
  let n = 0;
  for (const msg of messages) if (msg.role === "user" && !isIgnoredUserMessage(msg)) n++;
  return n;
}

/**
 * Rebuild the tool-parameter index from scratch off the current messages.
 *
 * Associates each tool_use (assistant) with its tool_result (next user turn) to
 * derive status. Token counts are estimated per tool_use+tool_result pair.
 * Resets `state.toolParameters` and `state.toolIdList`.
 */
export function buildToolMetadata(state: SessionState, messages: AgentMessage[]): void {
  const params = new Map<string, ToolParameterEntry>();
  const idList: string[] = [];
  let turn = 0;

  for (const msg of messages) {
    if (msg.role === "user" && !isIgnoredUserMessage(msg)) turn++;

    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (isToolUseBlock(block)) {
        const id = block.id;
        const entry: ToolParameterEntry = params.get(id) ?? {
          tool: block.name,
          parameters: block.input,
          status: "completed",
          turn,
          tokenCount: estimateBlockTokens(block),
        };
        entry.tool = block.name;
        entry.parameters = block.input;
        entry.turn = turn;
        params.set(id, entry);
        if (!idList.includes(id)) idList.push(id);
      } else if (isToolResultBlock(block)) {
        const entry = params.get(block.tool_use_id);
        if (entry) {
          entry.status = isErrorToolResult(block) ? "error" : "completed";
          // add the result's own token cost
          entry.tokenCount = (entry.tokenCount ?? 0) + estimateBlockTokens(block);
        }
      }
    }
  }

  state.toolParameters = params;
  state.toolIdList = idList;
}
