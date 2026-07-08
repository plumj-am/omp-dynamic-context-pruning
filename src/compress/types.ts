import type { AgentMessage } from "../omp";
import type { CompressionBlock, SessionState } from "../state/types";
import type { Logger } from "../logger";

/** Model-authored compress arguments. */
export interface CompressRangeEntry {
  startId: string;
  endId: string;
  summary: string;
}

export interface CompressRangeToolArgs {
  topic: string;
  content: CompressRangeEntry[];
}

export type BoundaryReference =
  | { kind: "message"; identity: string; rawIndex: number }
  | { kind: "compressed-block"; blockId: number; rawIndex: number };

export interface SelectionResolution {
  messageIds: string[];
  toolIds: string[];
  messageTokenById: Map<string, number>;
  /** Prior compressed blocks consumed by this range (anchor inside the span). */
  requiredBlockIds: number[];
  startReference: BoundaryReference;
  endReference: BoundaryReference;
}

export interface ResolvedRangeCompression {
  index: number;
  entry: { startId: string; endId: string; summary: string };
  selection: SelectionResolution;
  anchorMessageId: string;
}

/** Identity-indexed view of the live conversation for range resolution. */
export interface RangeContext {
  identities: string[];
  messages: AgentMessage[];
  identityToIndex: Map<string, number>;
  toolUseIdsByIdentity: Map<string, string[]>;
  messageByIdentity: Map<string, AgentMessage>;
  summaryByBlockId: Map<number, CompressionBlock>;
}

export interface ParsedBlockPlaceholder {
  raw: string;
  blockId: number;
  startIndex: number;
  endIndex: number;
}

export interface InjectedSummaryResult {
  expandedSummary: string;
  consumedBlockIds: number[];
}

export type ToolContext = {
  state: SessionState;
  logger: Logger;
};
