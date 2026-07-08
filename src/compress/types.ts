import type { AgentMessage } from "../omp";
import type { CompressionBlock, SessionState } from "../state/types";
import type { Logger } from "../logger";

/** Model-authored compress arguments. Boundaries are content anchors: short
 *  verbatim snippets quoted from the first / last message of the range. */
export interface CompressRangeEntry {
  startAnchor: string;
  endAnchor: string;
  summary: string;
}

export interface CompressRangeToolArgs {
  topic: string;
  content: CompressRangeEntry[];
}

export interface SelectionResolution {
  messageIds: string[];
  toolIds: string[];
  messageTokenById: Map<string, number>;
  /** Prior compressed blocks whose summary header appears inside the range. */
  requiredBlockIds: number[];
  startIndex: number;
  endIndex: number;
}

export interface ResolvedRangeCompression {
  index: number;
  entry: { startAnchor: string; endAnchor: string; summary: string };
  selection: SelectionResolution;
  anchorMessageId: string;
}

/** Identity- and search-indexed view of the live conversation. */
export interface RangeContext {
  identities: string[];
  messages: AgentMessage[];
  /** Normalized searchable text per message (text + tool calls + results). */
  searchText: string[];
  identityToIndex: Map<string, number>;
  toolUseIdsByIdentity: Map<string, string[]>;
  messageByIdentity: Map<string, AgentMessage>;
  summaryByBlockId: Map<number, CompressionBlock>;
}

export interface InjectedSummaryResult {
  expandedSummary: string;
  consumedBlockIds: number[];
}

export type ToolContext = {
  state: SessionState;
  logger: Logger;
};
