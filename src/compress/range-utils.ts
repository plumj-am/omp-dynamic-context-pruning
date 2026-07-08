/**
 * Range resolution, nesting, and placeholder handling for the compress tool.
 *
 * Adapted from DCP `lib/compress/range-utils.ts` + `lib/compress/search.ts`,
 * keyed on content identity instead of OpenCode message ids. The model cites
 * `m0001` / `b2` boundaries; we resolve those to identities via the ref→identity
 * map the context handler stashed on the last pass.
 */

import type { AgentMessage } from "../omp";
import type { CompressionBlock, SessionState } from "../state/types";
import { estimateMessageTokens } from "../token-utils";
import { isToolUseBlock } from "../messages/shape";
import { computeIdentities, parseBoundaryId } from "../messages/identity";
import { getLastUserMessageIndex, isIgnoredUserMessage } from "../messages/query";
import type {
  BoundaryReference,
  CompressRangeToolArgs,
  InjectedSummaryResult,
  ParsedBlockPlaceholder,
  RangeContext,
  ResolvedRangeCompression,
  SelectionResolution,
} from "./types";

const BLOCK_PLACEHOLDER_REGEX = /\(b(\d+)\)|\{block_(\d+)\}/gi;

export function validateArgs(args: CompressRangeToolArgs): void {
  if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
    throw new Error("topic is required and must be a non-empty string");
  }
  if (!Array.isArray(args.content) || args.content.length === 0) {
    throw new Error("content is required and must be a non-empty array");
  }
  for (let index = 0; index < args.content.length; index++) {
    const entry = args.content[index];
    const prefix = `content[${index}]`;
    if (typeof entry?.startId !== "string" || entry.startId.trim().length === 0) {
      throw new Error(`${prefix}.startId is required and must be a non-empty string`);
    }
    if (typeof entry?.endId !== "string" || entry.endId.trim().length === 0) {
      throw new Error(`${prefix}.endId is required and must be a non-empty string`);
    }
    if (typeof entry?.summary !== "string" || entry.summary.trim().length === 0) {
      throw new Error(`${prefix}.summary is required and must be a non-empty string`);
    }
  }
}

/**
 * Build an identity-indexed view of the conversation from a list of messages.
 * `messages` should be the live LLM-facing array the model just saw (so m-refs
 * align). Tool ids and token estimates are derived per message.
 */
export function buildRangeContext(messages: AgentMessage[], state: SessionState): RangeContext {
  const identities = computeIdentities(messages, state.isSubAgent);
  const identityToIndex = new Map<string, number>();
  const toolUseIdsByIdentity = new Map<string, string[]>();
  const messageByIdentity = new Map<string, AgentMessage>();

  for (let i = 0; i < messages.length; i++) {
    const identity = identities[i];
    if (!identity) continue;
    identityToIndex.set(identity, i);
    messageByIdentity.set(identity, messages[i]);
    const toolIds: string[] = [];
    const content = Array.isArray(messages[i].content) ? messages[i].content : [];
    for (const block of content) if (isToolUseBlock(block)) toolIds.push(block.id);
    if (toolIds.length > 0) toolUseIdsByIdentity.set(identity, toolIds);
  }

  return {
    identities,
    messages,
    identityToIndex,
    toolUseIdsByIdentity,
    messageByIdentity,
    summaryByBlockId: state.prune.messages.blocksById,
  };
}

function resolveBoundary(ctx: RangeContext, state: SessionState, id: string): BoundaryReference {
  const parsed = parseBoundaryId(id);
  if (!parsed) throw new Error(`Unrecognized boundary id: "${id}". Use m#### or b# form.`);

  if (parsed.kind === "compressed-block") {
    const block = state.prune.messages.blocksById.get(parsed.blockId);
    if (!block) throw new Error(`Compressed block ${parsed.ref} does not exist`);
    const idx = ctx.identityToIndex.get(block.anchorMessageId);
    if (idx === undefined) throw new Error(`Compressed block ${parsed.ref} anchor is not in the current context`);
    return { kind: "compressed-block", blockId: parsed.blockId, rawIndex: idx };
  }

  // message ref → identity → index
  const identity = state.messageIds.byRef.get(parsed.ref);
  if (!identity) throw new Error(`Message ref ${parsed.ref} is not in the current context`);
  const idx = ctx.identityToIndex.get(identity);
  if (idx === undefined) throw new Error(`Message ${parsed.ref} (${identity}) is not in the current context`);
  return { kind: "message", identity, rawIndex: idx };
}

function resolveSelection(ctx: RangeContext, start: BoundaryReference, end: BoundaryReference): SelectionResolution {
  const from = Math.min(start.rawIndex, end.rawIndex);
  const to = Math.max(start.rawIndex, end.rawIndex);
  const messageIds: string[] = [];
  const toolIds: string[] = [];
  const messageTokenById = new Map<string, number>();
  const messageIdSet = new Set<string>();

  for (let i = from; i <= to; i++) {
    const identity = ctx.identities[i];
    if (!identity) continue;
    messageIds.push(identity);
    messageIdSet.add(identity);
    messageTokenById.set(identity, estimateMessageTokens(ctx.messages[i]));
    const ids = ctx.toolUseIdsByIdentity.get(identity);
    if (ids) for (const id of ids) if (!toolIds.includes(id)) toolIds.push(id);
  }

  // Prior compressed blocks whose anchor falls inside the range are consumed by it.
  const requiredBlockIds: number[] = [];
  for (const [blockId, block] of ctx.summaryByBlockId) {
    if (messageIdSet.has(block.anchorMessageId) && !requiredBlockIds.includes(blockId)) {
      requiredBlockIds.push(blockId);
    }
  }

  return { messageIds, toolIds, messageTokenById, requiredBlockIds, startReference: start, endReference: end };
}

function resolveAnchorMessageId(ctx: RangeContext, start: BoundaryReference): string {
  const userIndex = getLastUserMessageIndex(ctx.messages, start.rawIndex);
  if (userIndex < 0) {
    // no preceding user message: anchor on the range start itself
    return start.kind === "message" ? start.identity : ctx.identities[start.rawIndex];
  }
  const anchorIdentity = ctx.identities[userIndex];
  return anchorIdentity || (start.kind === "message" ? start.identity : ctx.identities[start.rawIndex]);
}

export function resolveRanges(args: CompressRangeToolArgs, ctx: RangeContext, state: SessionState): ResolvedRangeCompression[] {
  return args.content.map((entry, index) => {
    const normalized = { startId: entry.startId.trim(), endId: entry.endId.trim(), summary: entry.summary };
    const start = resolveBoundary(ctx, state, normalized.startId);
    const end = resolveBoundary(ctx, state, normalized.endId);
    const selection = resolveSelection(ctx, start, end);
    return { index, entry: normalized, selection, anchorMessageId: resolveAnchorMessageId(ctx, start) };
  });
}

export function validateNonOverlapping(plans: ResolvedRangeCompression[]): void {
  const sorted = [...plans].sort((a, b) => a.selection.startReference.rawIndex - b.selection.startReference.rawIndex || a.selection.endReference.rawIndex - b.selection.endReference.rawIndex || a.index - b.index);
  const issues: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) continue;
    if (cur.selection.startReference.rawIndex > prev.selection.endReference.rawIndex) continue;
    issues.push(`content[${prev.index}] (${prev.entry.startId}..${prev.entry.endId}) overlaps content[${cur.index}] (${cur.entry.startId}..${cur.entry.endId}). Overlapping ranges cannot be compressed in the same batch.`);
  }
  if (issues.length > 0) throw new Error(issues.length === 1 ? issues[0] : issues.map((s) => `- ${s}`).join("\n"));
}

// ---------------------------------------------------------------------------
// Nested-block placeholder handling
// ---------------------------------------------------------------------------

export function parseBlockPlaceholders(summary: string): ParsedBlockPlaceholder[] {
  const placeholders: ParsedBlockPlaceholder[] = [];
  const regex = new RegExp(BLOCK_PLACEHOLDER_REGEX);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(summary)) !== null) {
    const full = match[0];
    const part = match[1] || match[2];
    const parsed = Number.parseInt(part, 10);
    if (Number.isInteger(parsed)) placeholders.push({ raw: full, blockId: parsed, startIndex: match.index, endIndex: match.index + full.length });
  }
  return placeholders;
}

/** Block ids that a range consumes (already-compressed blocks nested inside). */
export function consumedBlockIdsIn(selection: SelectionResolution, ctx: RangeContext): number[] {
  const consumed: number[] = [];
  for (const identity of selection.messageIds) {
    for (const [blockId, block] of ctx.summaryByBlockId) {
      if (block.anchorMessageId === identity && !consumed.includes(blockId)) consumed.push(blockId);
    }
  }
  return consumed;
}

export function injectBlockPlaceholders(
  summary: string,
  placeholders: ParsedBlockPlaceholder[],
  summaryByBlockId: Map<number, CompressionBlock>,
  startReference: BoundaryReference,
  endReference: BoundaryReference,
): InjectedSummaryResult {
  const consumed: number[] = [];
  const consumedSeen = new Set<number>();
  let expanded = summary;
  if (placeholders.length > 0) {
    let cursor = 0;
    expanded = "";
    for (const placeholder of placeholders) {
      const target = summaryByBlockId.get(placeholder.blockId);
      if (!target) throw new Error(`Compressed block not found: (b${placeholder.blockId})`);
      expanded += summary.slice(cursor, placeholder.startIndex);
      expanded += restoreSummary(target.summary);
      cursor = placeholder.endIndex;
      if (!consumedSeen.has(placeholder.blockId)) {
        consumedSeen.add(placeholder.blockId);
        consumed.push(placeholder.blockId);
      }
    }
    expanded += summary.slice(cursor);
  }

  // When the range boundary is itself a compressed block, fold its summary in
  // at that edge (start → prepend, end → append) and mark it consumed.
  expanded = injectBoundarySummary(expanded, startReference, "start", summaryByBlockId, consumed, consumedSeen);
  expanded = injectBoundarySummary(expanded, endReference, "end", summaryByBlockId, consumed, consumedSeen);

  return { expandedSummary: expanded, consumedBlockIds: consumed };
}

function injectBoundarySummary(
  summary: string,
  reference: BoundaryReference,
  position: "start" | "end",
  summaryByBlockId: Map<number, CompressionBlock>,
  consumed: number[],
  consumedSeen: Set<number>,
): string {
  if (reference.kind !== "compressed-block") return summary;
  if (consumedSeen.has(reference.blockId)) return summary;
  const target = summaryByBlockId.get(reference.blockId);
  if (!target) throw new Error(`Compressed block not found: (b${reference.blockId})`);
  const injectedBody = restoreSummary(target.summary);
  const left = position === "start" ? injectedBody.trim() : summary.trim();
  const right = position === "start" ? summary.trim() : injectedBody.trim();
  const next = !left ? right : !right ? left : `${left}\n\n${right}`;
  consumedSeen.add(reference.blockId);
  consumed.push(reference.blockId);
  return next;
}

export function appendMissingBlockSummaries(
  summary: string,
  missingBlockIds: number[],
  summaryByBlockId: Map<number, CompressionBlock>,
  consumedBlockIds: number[],
): InjectedSummaryResult {
  const consumedSeen = new Set(consumedBlockIds);
  const consumed = [...consumedBlockIds];
  const missing: string[] = [];
  for (const blockId of missingBlockIds) {
    if (consumedSeen.has(blockId)) continue;
    const target = summaryByBlockId.get(blockId);
    if (!target) throw new Error(`Compressed block not found: (b${blockId})`);
    missing.push(`\n### (b${blockId})\n${restoreSummary(target.summary)}`);
    consumedSeen.add(blockId);
    consumed.push(blockId);
  }
  if (missing.length === 0) return { expandedSummary: summary, consumedBlockIds: consumed };
  const heading = "\n\nThe following previously compressed summaries were also part of this conversation section:";
  return { expandedSummary: summary + heading + missing.join(""), consumedBlockIds: consumed };
}

/** Strip the `[Compressed conversation section]` header and trailing block tag. */
function restoreSummary(summary: string): string {
  const headerMatch = summary.match(/^\s*\[Compressed conversation(?: section)?(?: b\d+)?\]/i);
  if (!headerMatch) return summary;
  const after = summary.slice(headerMatch[0].length).replace(/^(?:\r?\n)+/, "");
  return after.replace(/(?:\r?\n)*<dcp-message-id>b\d+<\/dcp-message-id>\s*$/i, "").replace(/(?:\r?\n)+$/, "");
}

/**
 * Validate placeholders against required block ids. Boundary blocks (when the
 * range start or end is itself a compressed block) are excluded from the
 * "strict required" set because they are injected separately by
 * injectBoundarySummary, not via an explicit `(b#)` placeholder.
 */
export function validateSummaryPlaceholders(
  placeholders: ParsedBlockPlaceholder[],
  requiredBlockIds: number[],
  startReference: BoundaryReference,
  endReference: BoundaryReference,
  summaryByBlockId: Map<number, CompressionBlock>,
): number[] {
  const boundaryOptionalIds = new Set<number>();
  if (startReference.kind === "compressed-block") boundaryOptionalIds.add(startReference.blockId);
  if (endReference.kind === "compressed-block") boundaryOptionalIds.add(endReference.blockId);

  const strictRequired = requiredBlockIds.filter((id) => !boundaryOptionalIds.has(id));
  const requiredSet = new Set(requiredBlockIds);
  const kept = new Set<number>();
  const valid: ParsedBlockPlaceholder[] = [];
  for (const p of placeholders) {
    if (summaryByBlockId.has(p.blockId) && requiredSet.has(p.blockId) && !kept.has(p.blockId)) {
      valid.push(p);
      kept.add(p.blockId);
    }
  }
  placeholders.length = 0;
  placeholders.push(...valid);
  return strictRequired.filter((id) => !kept.has(id));
}
