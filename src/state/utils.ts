import type { CompressionBlock, CompressionMode, PruneMessagesState, PrunedMessageEntry, SessionState } from "./types";

export const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]";

export function isMessageCompacted(state: SessionState, messageIdentity: string): boolean {
  const entry = state.prune.messages.byMessageId.get(messageIdentity);
  return !!entry && entry.activeBlockIds.length > 0;
}

export function allocateBlockId(state: SessionState): number {
  const next = state.prune.messages.nextBlockId;
  if (!Number.isInteger(next) || next < 1) {
    state.prune.messages.nextBlockId = 2;
    return 1;
  }
  state.prune.messages.nextBlockId = next + 1;
  return next;
}

export function allocateRunId(state: SessionState): number {
  const next = state.prune.messages.nextRunId;
  if (!Number.isInteger(next) || next < 1) {
    state.prune.messages.nextRunId = 2;
    return 1;
  }
  state.prune.messages.nextRunId = next + 1;
  return next;
}

/**
 * Wrap a model-authored summary with a readable header carrying the block id
 * (e.g. `[Compressed conversation section · b2]`). The id in the header is how
 * the model cites the block for nesting — no `<dcp-message-id>` XML tags are
 * used anywhere, because omp surfaces context-hook output into the display and
 * those tags leaked to the user.
 */
export function wrapCompressedSummary(blockId: number, summary: string): string {
  const body = summary.trim();
  const header = `[Compressed conversation section · b${blockId}]`;
  return body.length === 0 ? header : `${header}\n${body}`;
}

/**
 * Apply a compression block to prune state: register the block, nest/deactivate
 * consumed blocks, and tag affected message identities.
 *
 * Ported from DCP `applyCompressionState`, keyed on content identities.
 */
export interface ApplyCompressionInput {
  topic: string;
  batchTopic: string;
  startId: string;
  endId: string;
  mode: CompressionMode | undefined;
  runId: number;
  compressMessageId?: string;
  compressCallId?: string;
  summaryTokens: number;
}

export interface SelectionResolution {
  messageIds: string[];
  toolIds: string[];
  messageTokenById: Map<string, number>;
}

export interface AppliedCompressionResult {
  compressedTokens: number;
  messageIds: string[];
  newlyCompressedMessageIds: string[];
  newlyCompressedToolIds: string[];
}

export function applyCompressionState(
  state: SessionState,
  input: ApplyCompressionInput,
  selection: SelectionResolution,
  anchorMessageId: string,
  blockId: number,
  summary: string,
  consumedBlockIds: number[],
): AppliedCompressionResult {
  const messagesState = state.prune.messages;
  const consumed = [...new Set(consumedBlockIds.filter((id) => Number.isInteger(id) && id > 0))];
  const included = [...consumed];

  const effectiveMessageIds = new Set<string>(selection.messageIds);
  const effectiveToolIds = new Set<string>(selection.toolIds);

  for (const consumedBlockId of consumed) {
    const consumedBlock = messagesState.blocksById.get(consumedBlockId);
    if (!consumedBlock) continue;
    for (const id of consumedBlock.effectiveMessageIds) effectiveMessageIds.add(id);
    for (const id of consumedBlock.effectiveToolIds) effectiveToolIds.add(id);
  }

  const initiallyActiveMessages = new Set<string>();
  for (const messageId of effectiveMessageIds) {
    const entry = messagesState.byMessageId.get(messageId);
    if (entry && entry.activeBlockIds.length > 0) initiallyActiveMessages.add(messageId);
  }

  const initiallyActiveToolIds = new Set<string>();
  for (const activeBlockId of messagesState.activeBlockIds) {
    const activeBlock = messagesState.blocksById.get(activeBlockId);
    if (!activeBlock || !activeBlock.active) continue;
    for (const id of activeBlock.effectiveToolIds) initiallyActiveToolIds.add(id);
  }

  const createdAt = Date.now();
  const block: CompressionBlock = {
    blockId,
    runId: input.runId,
    active: true,
    deactivatedByUser: false,
    compressedTokens: 0,
    summaryTokens: input.summaryTokens,
    durationMs: 0,
    mode: input.mode,
    topic: input.topic,
    batchTopic: input.batchTopic,
    startId: input.startId,
    endId: input.endId,
    anchorMessageId,
    compressMessageId: input.compressMessageId,
    compressCallId: input.compressCallId,
    includedBlockIds: included,
    consumedBlockIds: consumed,
    parentBlockIds: [],
    directMessageIds: [],
    directToolIds: [],
    effectiveMessageIds: [...effectiveMessageIds],
    effectiveToolIds: [...effectiveToolIds],
    createdAt,
    summary,
  };

  messagesState.blocksById.set(blockId, block);
  messagesState.activeBlockIds.add(blockId);
  messagesState.activeByAnchorMessageId.set(anchorMessageId, blockId);

  const deactivatedAt = Date.now();
  for (const consumedBlockId of consumed) {
    const consumedBlock = messagesState.blocksById.get(consumedBlockId);
    if (!consumedBlock || !consumedBlock.active) continue;
    consumedBlock.active = false;
    consumedBlock.deactivatedAt = deactivatedAt;
    consumedBlock.deactivatedByBlockId = blockId;
    if (!consumedBlock.parentBlockIds.includes(blockId)) consumedBlock.parentBlockIds.push(blockId);
    messagesState.activeBlockIds.delete(consumedBlockId);
    if (messagesState.activeByAnchorMessageId.get(consumedBlock.anchorMessageId) === consumedBlockId) {
      messagesState.activeByAnchorMessageId.delete(consumedBlock.anchorMessageId);
    }
  }

  for (const consumedBlockId of consumed) {
    const consumedBlock = messagesState.blocksById.get(consumedBlockId);
    if (!consumedBlock) continue;
    for (const messageId of consumedBlock.effectiveMessageIds) {
      removeActiveBlockId(messagesState, messageId, consumedBlockId);
    }
  }

  for (const messageId of selection.messageIds) {
    const tokenCount = selection.messageTokenById.get(messageId) || 0;
    upsertPrunedEntry(messagesState, messageId, blockId, tokenCount);
  }
  for (const messageId of block.effectiveMessageIds) {
    if (selection.messageTokenById.has(messageId)) continue;
    upsertPrunedEntry(messagesState, messageId, blockId, 0);
  }

  const newlyCompressedMessageIds: string[] = [];
  let compressedTokens = 0;
  for (const messageId of effectiveMessageIds) {
    const entry = messagesState.byMessageId.get(messageId);
    if (!entry) continue;
    const isNowActive = entry.activeBlockIds.length > 0;
    const wasActive = initiallyActiveMessages.has(messageId);
    if (isNowActive && !wasActive) {
      compressedTokens += entry.tokenCount;
      newlyCompressedMessageIds.push(messageId);
    }
  }

  const newlyCompressedToolIds: string[] = [];
  for (const toolId of effectiveToolIds) {
    if (!initiallyActiveToolIds.has(toolId)) newlyCompressedToolIds.push(toolId);
  }

  block.directMessageIds = [...newlyCompressedMessageIds];
  block.directToolIds = [...newlyCompressedToolIds];
  block.compressedTokens = compressedTokens;

  state.stats.pruneTokenCounter += compressedTokens;
  state.stats.totalPruneTokens += state.stats.pruneTokenCounter;
  state.stats.pruneTokenCounter = 0;

  return {
    compressedTokens,
    messageIds: selection.messageIds,
    newlyCompressedMessageIds,
    newlyCompressedToolIds,
  };
}

function upsertPrunedEntry(messagesState: PruneMessagesState, messageId: string, blockId: number, tokenCount: number): void {
  const existing = messagesState.byMessageId.get(messageId);
  if (!existing) {
    messagesState.byMessageId.set(messageId, {
      tokenCount,
      allBlockIds: [blockId],
      activeBlockIds: [blockId],
    });
    return;
  }
  existing.tokenCount = Math.max(existing.tokenCount, tokenCount);
  if (!existing.allBlockIds.includes(blockId)) existing.allBlockIds.push(blockId);
  if (!existing.activeBlockIds.includes(blockId)) existing.activeBlockIds.push(blockId);
}

function removeActiveBlockId(messagesState: PruneMessagesState, messageId: string, blockId: number): void {
  const entry = messagesState.byMessageId.get(messageId);
  if (!entry || entry.activeBlockIds.length === 0) return;
  entry.activeBlockIds = entry.activeBlockIds.filter((id) => id !== blockId);
}

/** True if a block with this id exists and is active. */
export function isActiveBlock(state: SessionState, blockId: number): boolean {
  const block = state.prune.messages.blocksById.get(blockId);
  return !!block && block.active;
}
