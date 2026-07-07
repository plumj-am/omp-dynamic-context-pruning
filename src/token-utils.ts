/**
 * Token estimation for omp AgentMessages.
 *
 * ~4 chars/token estimator (the same fallback DCP uses when its tokenizer
 * throws). Surface is narrow so a real tokenizer can be slotted in later
 * without touching call sites. Reads content blocks through the verified
 * guards in `messages/shape.ts` — no unchecked casts.
 */

import type { AgentMessage, ContentBlock } from "./omp";
import { isTextBlock, isToolUseBlock, isToolResultBlock, toolResultText } from "./messages/shape";

export function countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function blockText(block: ContentBlock): string {
  if (isTextBlock(block)) return block.text;
  if (isToolUseBlock(block)) return `${block.name} ${stringify(block.input)}`;
  if (isToolResultBlock(block)) return toolResultText(block);
  if (typeof block === "object" && block !== null && "type" in block && (block as { type: unknown }).type === "thinking") {
    const b = block as { thinking?: unknown; text?: unknown };
    return typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : stringify(b);
  }
  return stringify(block);
}

export function estimateBlockTokens(block: ContentBlock): number {
  return countTokens(blockText(block));
}

export function estimateMessageTokens(msg: AgentMessage): number {
  if (!Array.isArray(msg.content)) return 0;
  let total = 0;
  for (const block of msg.content) total += estimateBlockTokens(block);
  return total;
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

/** Total estimated tokens for a set of tool_use ids across the messages. */
export function totalToolTokens(messages: AgentMessage[], toolUseIds: Set<string>): number {
  if (toolUseIds.size === 0) return 0;
  let total = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (isToolUseBlock(block) && toolUseIds.has(block.id)) total += estimateBlockTokens(block);
      else if (isToolResultBlock(block) && toolUseIds.has(block.tool_use_id)) total += estimateBlockTokens(block);
    }
  }
  return total;
}
