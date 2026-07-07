/**
 * Append protected content into a model-authored compression summary:
 *  - protected tool outputs (always — compress.protectedTools)
 *  - verbatim user messages (compress.protectUserMessages)
 *  - <protect>…</protect> wrapped spans (compress.protectTags)
 *
 * Adapted from DCP `lib/compress/protected-content.ts` to the omp content-block
 * model. Operates on the RangeContext's identity→message map.
 */

import type { SelectionResolution, RangeContext } from "./types";
import type { SessionState } from "../state/types";
import { isToolUseBlock, isToolResultBlock, isTextBlock, toolResultText } from "../messages/shape";
import { isIgnoredUserMessage } from "../messages/query";
import { getFilePathsFromParameters, isFilePathProtected, isToolNameProtected } from "../protected-patterns";

export function appendProtectedUserMessages(
  summary: string,
  selection: SelectionResolution,
  ctx: RangeContext,
  state: SessionState,
  enabled: boolean,
): string {
  if (!enabled) return summary;
  const texts: string[] = [];
  for (const identity of selection.messageIds) {
    if (isAlreadyCompressed(state, identity)) continue;
    const message = ctx.messageByIdentity.get(identity);
    if (!message || message.role !== "user") continue;
    if (isIgnoredUserMessage(message)) continue;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (isTextBlock(block) && block.text.trim()) {
        texts.push(block.text);
        break;
      }
    }
  }
  if (texts.length === 0) return summary;
  return `${summary}\n\nThe following user messages were sent in this conversation verbatim:${texts.map((t) => `\n${t}`).join("")}`;
}

export function appendProtectedPromptInfo(
  summary: string,
  selection: SelectionResolution,
  ctx: RangeContext,
  state: SessionState,
  enabled: boolean,
): string {
  if (!enabled) return summary;
  const protectedTexts: string[] = [];
  for (const identity of selection.messageIds) {
    if (isAlreadyCompressed(state, identity)) continue;
    const message = ctx.messageByIdentity.get(identity);
    if (!message || message.role !== "user") continue;
    if (isIgnoredUserMessage(message)) continue;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!isTextBlock(block)) continue;
      for (const m of block.text.matchAll(/<protect>([\s\S]*?)<\/protect>/gi)) {
        const t = m[1]?.trim();
        if (t) protectedTexts.push(t);
      }
    }
  }
  if (protectedTexts.length === 0) return summary;
  return `${summary}\n\nThe following protected prompt information was included in this conversation verbatim:${protectedTexts.map((t) => `\n${t}`).join("")}`;
}

export function appendProtectedTools(
  summary: string,
  selection: SelectionResolution,
  ctx: RangeContext,
  state: SessionState,
  protectedTools: string[],
  protectedFilePatterns: string[],
): string {
  const outputs: string[] = [];
  for (const identity of selection.messageIds) {
    if (isAlreadyCompressed(state, identity)) continue;
    const message = ctx.messageByIdentity.get(identity);
    if (!message) continue;
    const content = Array.isArray(message.content) ? message.content : [];

    // tool_use (input) and its tool_result (output) may both live in this range
    for (const block of content) {
      if (!isToolUseBlock(block)) continue;
      let protectedTool = isToolNameProtected(block.name, protectedTools);
      if (!protectedTool && protectedFilePatterns.length > 0) {
        const filePaths = getFilePathsFromParameters(block.name, block.input);
        if (isFilePathProtected(filePaths, protectedFilePatterns)) protectedTool = true;
      }
      if (!protectedTool) continue;

      const output = findToolResultText(ctx, selection, block.id) || stringifyInput(block.input);
      if (output) outputs.push(`\n### Tool: ${block.name}\n${output}`);
    }
  }
  if (outputs.length === 0) return summary;
  return `${summary}\n\nThe following protected tools were used in this conversation as well:${outputs.join("")}`;
}

function findToolResultText(ctx: RangeContext, selection: SelectionResolution, toolUseId: string): string {
  for (const identity of selection.messageIds) {
    const message = ctx.messageByIdentity.get(identity);
    if (!message) continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (isToolResultBlock(block) && block.tool_use_id === toolUseId) return toolResultText(block);
    }
  }
  return "";
}

function stringifyInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function isAlreadyCompressed(state: SessionState, identity: string): boolean {
  const entry = state.prune.messages.byMessageId.get(identity);
  return !!entry && entry.activeBlockIds.length > 0;
}
