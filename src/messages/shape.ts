/**
 * Typed, runtime-checked accessors for omp AgentMessage content blocks.
 *
 * omp messages arrive as `AgentMessage` with `content: ContentBlock[]`, but the
 * block union is loose (the docs show the canonical shapes; the live array may
 * carry provider-specific extras). Every accessor here narrows with `typeof` /
 * `in` checks so reads are compiler-verified — no unchecked casts.
 */

import type { AgentMessage, ContentBlock, ToolUseBlock, ToolResultBlock, TextBlock, ThinkingBlock } from "../omp";

export function isTextBlock(b: ContentBlock): b is TextBlock {
  return typeof b === "object" && b !== null && "type" in b && (b as { type: unknown }).type === "text" && "text" in b && typeof (b as { text: unknown }).text === "string";
}

export function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return (
    typeof b === "object" &&
    b !== null &&
    "type" in b &&
    (b as { type: unknown }).type === "tool_use" &&
    "id" in b &&
    typeof (b as { id: unknown }).id === "string" &&
    "name" in b &&
    typeof (b as { name: unknown }).name === "string"
  );
}

export function isToolResultBlock(b: ContentBlock): b is ToolResultBlock {
  return (
    typeof b === "object" &&
    b !== null &&
    "type" in b &&
    (b as { type: unknown }).type === "tool_result" &&
    "tool_use_id" in b &&
    typeof (b as { tool_use_id: unknown }).tool_use_id === "string"
  );
}

export function isThinkingBlock(b: ContentBlock): b is ThinkingBlock {
  return typeof b === "object" && b !== null && "type" in b && (b as { type: unknown }).type === "thinking";
}

export function isErrorToolResult(b: ContentBlock): boolean {
  return isToolResultBlock(b) && "is_error" in b && (b as { is_error: unknown }).is_error === true;
}

/** All tool_use blocks in a message's content (assistant tool calls). */
export function toolUseBlocks(msg: AgentMessage): ToolUseBlock[] {
  if (!Array.isArray(msg.content)) return [];
  const out: ToolUseBlock[] = [];
  for (const b of msg.content) if (isToolUseBlock(b)) out.push(b);
  return out;
}

/** All tool_result blocks in a message's content (user-role tool results). */
export function toolResultBlocks(msg: AgentMessage): ToolResultBlock[] {
  if (!Array.isArray(msg.content)) return [];
  const out: ToolResultBlock[] = [];
  for (const b of msg.content) if (isToolResultBlock(b)) out.push(b);
  return out;
}

export function textBlocks(msg: AgentMessage): TextBlock[] {
  if (!Array.isArray(msg.content)) return [];
  const out: TextBlock[] = [];
  for (const b of msg.content) if (isTextBlock(b)) out.push(b);
  return out;
}

export function messageText(msg: AgentMessage): string {
  return textBlocks(msg)
    .map((b) => b.text)
    .join("");
}

export function hasToolUse(msg: AgentMessage): boolean {
  if (!Array.isArray(msg.content)) return false;
  for (const b of msg.content) if (isToolUseBlock(b)) return true;
  return false;
}

export function hasToolResult(msg: AgentMessage): boolean {
  if (!Array.isArray(msg.content)) return false;
  for (const b of msg.content) if (isToolResultBlock(b)) return true;
  return false;
}

/** tool_use ids in order of appearance across the message. */
export function toolUseIds(msg: AgentMessage): string[] {
  return toolUseBlocks(msg).map((b) => b.id);
}

/** Flatten a tool_result's content to a plain string. */
export function toolResultText(block: ToolResultBlock): string {
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const item of c) {
      if (typeof item === "string") parts.push(item);
      else if (typeof item === "object" && item !== null && "type" in item && (item as { type: unknown }).type === "text" && "text" in item && typeof (item as { text: unknown }).text === "string") {
        parts.push((item as { text: string }).text);
      }
    }
    return parts.join("");
  }
  return "";
}
