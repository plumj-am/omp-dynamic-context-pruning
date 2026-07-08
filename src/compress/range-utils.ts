/**
 * Range resolution for the compress tool, using CONTENT ANCHORS.
 *
 * The model cites a range by quoting a short verbatim snippet from the first
 * message (`startAnchor`) and the last message (`endAnchor`). The tool
 * substring-matches each anchor (whitespace- and case-normalized) to a message
 * and takes the span between them.
 *
 * No per-message tags, no positional numbering, no b# refs — nothing is
 * injected into context, so the model has nothing to imitate and pollute its
 * own output with. Prior compressed blocks nested inside a cited range are
 * auto-detected by their `[Compressed conversation section]` header and folded
 * into the new summary.
 */

import type { AgentMessage } from "../omp";
import type { CompressionBlock, SessionState } from "../state/types";
import { estimateMessageTokens } from "../token-utils";
import { isToolUseBlock, isToolResultBlock, isTextBlock, toolResultText } from "../messages/shape";
import { computeIdentities } from "../messages/identity";
import { getLastUserMessageIndex } from "../messages/query";
import type {
  CompressRangeToolArgs,
  InjectedSummaryResult,
  RangeContext,
  ResolvedRangeCompression,
  SelectionResolution,
} from "./types";

const HEADER_PREFIX = "[Compressed conversation section";

export function validateArgs(args: CompressRangeToolArgs): void {
  if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
    throw new Error("topic is required and must be a non-empty string");
  }
  if (!Array.isArray(args.content) || args.content.length === 0) {
    throw new Error("content is required and must be a non-empty array");
  }
  for (let i = 0; i < args.content.length; i++) {
    const entry = args.content[i];
    const prefix = `content[${i}]`;
    if (typeof entry?.startAnchor !== "string" || entry.startAnchor.trim().length < 3) {
      throw new Error(`${prefix}.startAnchor is required (at least 3 chars, quoted from the first message)`);
    }
    if (typeof entry?.endAnchor !== "string" || entry.endAnchor.trim().length < 3) {
      throw new Error(`${prefix}.endAnchor is required (at least 3 chars, quoted from the last message)`);
    }
    if (typeof entry?.summary !== "string" || entry.summary.trim().length === 0) {
      throw new Error(`${prefix}.summary is required and must be a non-empty string`);
    }
  }
}

/** Normalize text for fuzzy substring matching: lowercase, collapse whitespace. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** All searchable text in a message: text blocks + tool calls + tool results. */
function messageSearchText(msg: AgentMessage): string {
  let t = "";
  for (const b of Array.isArray(msg.content) ? msg.content : []) {
    if (isTextBlock(b)) t += b.text + " ";
    else if (isToolUseBlock(b)) t += `${b.name} ${stringify(b.input)} `;
    else if (isToolResultBlock(b)) t += toolResultText(b) + " ";
  }
  return normalize(t);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Find the first message at or after `fromIndex` whose text contains `anchor`. */
function findAnchorIndex(ctx: RangeContext, anchor: string, fromIndex: number): number {
  const needle = normalize(anchor);
  if (!needle) throw new Error("empty anchor");
  for (let i = fromIndex; i < ctx.messages.length; i++) {
    if (ctx.searchText[i].includes(needle)) return i;
  }
  throw new Error(
    `No message matched anchor "${anchor.length > 80 ? anchor.slice(0, 80) + "…" : anchor}". ` +
      `Quote a distinctive phrase that appears verbatim in the target message.`,
  );
}

/** Parse block ids from `[Compressed conversation section · b#]` headers in a message. */
function blockHeadersIn(msg: AgentMessage): number[] {
  const ids: number[] = [];
  for (const block of Array.isArray(msg.content) ? msg.content : []) {
    if (!isTextBlock(block)) continue;
    for (const m of block.text.matchAll(/\[Compressed conversation section · b(\d+)\]/gi)) {
      const id = Number.parseInt(m[1] ?? "", 10);
      if (Number.isInteger(id) && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

export function buildRangeContext(messages: AgentMessage[], state: SessionState): RangeContext {
  const identities = computeIdentities(messages, state.isSubAgent);
  const identityToIndex = new Map<string, number>();
  const toolUseIdsByIdentity = new Map<string, string[]>();
  const messageByIdentity = new Map<string, AgentMessage>();
  const searchText: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const identity = identities[i];
    searchText.push(messageSearchText(messages[i]));
    if (!identity) continue;
    identityToIndex.set(identity, i);
    messageByIdentity.set(identity, messages[i]);
    const toolIds: string[] = [];
    for (const block of Array.isArray(messages[i].content) ? messages[i].content : []) {
      if (isToolUseBlock(block)) toolIds.push(block.id);
    }
    if (toolIds.length > 0) toolUseIdsByIdentity.set(identity, toolIds);
  }

  return {
    identities,
    messages,
    searchText,
    identityToIndex,
    toolUseIdsByIdentity,
    messageByIdentity,
    summaryByBlockId: state.prune.messages.blocksById,
  };
}

function resolveSelection(ctx: RangeContext, startIndex: number, endIndex: number): SelectionResolution {
  const from = Math.min(startIndex, endIndex);
  const to = Math.max(startIndex, endIndex);
  const messageIds: string[] = [];
  const toolIds: string[] = [];
  const messageTokenById = new Map<string, number>();
  const requiredBlockIds: number[] = [];

  for (let i = from; i <= to; i++) {
    const identity = ctx.identities[i];
    if (identity) {
      messageIds.push(identity);
      messageTokenById.set(identity, estimateMessageTokens(ctx.messages[i]));
      const ids = ctx.toolUseIdsByIdentity.get(identity);
      if (ids) for (const id of ids) if (!toolIds.includes(id)) toolIds.push(id);
    }
    for (const blockId of blockHeadersIn(ctx.messages[i])) {
      if (!requiredBlockIds.includes(blockId)) requiredBlockIds.push(blockId);
    }
  }

  return { messageIds, toolIds, messageTokenById, requiredBlockIds, startIndex: from, endIndex: to };
}

function resolveAnchorMessageId(ctx: RangeContext, startIndex: number): string {
  const userIndex = getLastUserMessageIndex(ctx.messages, startIndex);
  if (userIndex >= 0) return ctx.identities[userIndex] || `pos:${startIndex}`;
  const here = ctx.identities[startIndex];
  return here || `pos:${startIndex}`;
}

export function resolveRanges(args: CompressRangeToolArgs, ctx: RangeContext): ResolvedRangeCompression[] {
  return args.content.map((entry, index) => {
    const startIdx = findAnchorIndex(ctx, entry.startAnchor, 0);
    const endIdx = findAnchorIndex(ctx, entry.endAnchor, startIdx);
    const selection = resolveSelection(ctx, startIdx, endIdx);
    return {
      index,
      entry: { startAnchor: entry.startAnchor, endAnchor: entry.endAnchor, summary: entry.summary },
      selection,
      anchorMessageId: resolveAnchorMessageId(ctx, startIdx),
    };
  });
}

export function validateNonOverlapping(plans: ResolvedRangeCompression[]): void {
  const sorted = [...plans].sort(
    (a, b) => a.selection.startIndex - b.selection.startIndex || a.selection.endIndex - b.selection.endIndex || a.index - b.index,
  );
  const issues: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) continue;
    if (cur.selection.startIndex > prev.selection.endIndex) continue;
    issues.push(
      `content[${prev.index}] overlaps content[${cur.index}] (messages ${prev.selection.startIndex + 1}..${prev.selection.endIndex + 1} ∩ ${cur.selection.startIndex + 1}..${cur.selection.endIndex + 1}). Overlapping ranges cannot be compressed in one batch.`,
    );
  }
  if (issues.length > 0) throw new Error(issues.length === 1 ? issues[0] : issues.map((s) => `- ${s}`).join("\n"));
}

/**
 * Fold the summaries of prior compressed blocks consumed by this range into the
 * new summary. Each consumed block's summary is appended (header stripped) under
 * a heading, so no information is lost through layers of compression.
 */
export function foldConsumedBlocks(
  summary: string,
  requiredBlockIds: number[],
  summaryByBlockId: Map<number, CompressionBlock>,
): InjectedSummaryResult {
  const consumed: number[] = [];
  const missing: string[] = [];
  for (const blockId of requiredBlockIds) {
    const target = summaryByBlockId.get(blockId);
    if (!target) continue;
    consumed.push(blockId);
    missing.push(`\n### (b${blockId})\n${restoreSummary(target.summary)}`);
  }
  if (missing.length === 0) return { expandedSummary: summary, consumedBlockIds: consumed };
  const heading = "\n\nThe following previously compressed summaries were also part of this conversation section:";
  return { expandedSummary: summary + heading + missing.join(""), consumedBlockIds: consumed };
}

/** Strip the `[Compressed conversation section · b#]` header from a stored summary. */
function restoreSummary(summary: string): string {
  const headerMatch = summary.match(/^\s*\[Compressed conversation section(?: · b\d+)?\]/i);
  if (!headerMatch) return summary;
  return summary.slice(headerMatch[0].length).replace(/^(?:\r?\n)+/, "").replace(/(?:\r?\n)+$/, "");
}
