/**
 * The compress tool (range mode). The model authors the summaries; this tool
 * validates ranges, nests prior compressions, appends protected content, and
 * stores compression blocks in session state.
 *
 * Registered via `pi.registerTool`. Dependencies (state/logger/config/zod/persist)
 * are captured in a factory closure.
 */

import type { ExtensionAPI, ToolDefinition, ToolResult, ContentBlock } from "../omp";
import type { PluginConfig } from "../config";
import type { Logger } from "../logger";
import type { SessionState } from "../state/types";
import { allocateBlockId, allocateRunId, applyCompressionState, wrapCompressedSummary } from "../state/utils";
import { formatBlockRef, formatMessageIdTag } from "../messages/identity";
import { countTokens } from "../token-utils";
import { DEFAULT_PROTECTED_TOOLS } from "../config";
import { appendMissingBlockSummaries, buildRangeContext, consumedBlockIdsIn, injectBlockPlaceholders, parseBlockPlaceholders, resolveRanges, validateArgs, validateNonOverlapping, validateSummaryPlaceholders } from "./range-utils";
import { appendProtectedTools, appendProtectedPromptInfo, appendProtectedUserMessages } from "./protected-content";
import { COMPRESS_RANGE_PROMPT, RANGE_FORMAT_EXTENSION } from "../prompts";
import { saveSessionState } from "../state/persistence";

export interface CompressToolDeps {
  state: SessionState;
  logger: Logger;
  config: PluginConfig;
  zod: ExtensionAPI["zod"];
  persist: () => void;
}

export function createCompressRangeTool(deps: CompressToolDeps): ToolDefinition {
  const { state, logger, config, zod, persist } = deps;
  const parameters = zod.object({
    topic: zod.string({ description: "Short label (3-5 words) for display - e.g., 'Auth System Exploration'" }),
    content: zod.array(
      zod.object({
        startId: zod.string({ description: "Message or block ID marking the beginning of range (e.g. m0001, b2)" }),
        endId: zod.string({ description: "Message or block ID marking the end of range (e.g. m0012, b5)" }),
        summary: zod.string({ description: "Complete technical summary replacing all content in range" }),
      }),
    ),
  });

  return {
    name: "compress",
    label: "Compress",
    description: COMPRESS_RANGE_PROMPT + RANGE_FORMAT_EXTENSION,
    parameters,
    async execute(toolCallId, params): Promise<ToolResult> {
      const args = params as { topic: string; content: { startId: string; endId: string; summary: string }[] };
      validateArgs(args);

      const messages = state.lastContextMessages;
      if (!messages || messages.length === 0) {
        throw new Error("No context messages available to compress. Try again on a later turn.");
      }

      const ctx = buildRangeContext(messages, state);
      const plans = resolveRanges(args, ctx, state);
      validateNonOverlapping(plans);

      const protectedTools = new Set([...DEFAULT_PROTECTED_TOOLS, ...config.compress.protectedTools]);
      const runId = allocateRunId(state);
      const notifications: { blockId: number; summary: string; summaryTokens: number }[] = [];
      let totalCompressed = 0;

      for (const plan of plans) {
        const consumedFromSelection = consumedBlockIdsIn(plan.selection, ctx);
        const placeholders = parseBlockPlaceholders(plan.entry.summary);
        const missing = validateSummaryPlaceholders(placeholders, consumedFromSelection, ctx.summaryByBlockId);
        const injected = injectBlockPlaceholders(plan.entry.summary, placeholders, ctx.summaryByBlockId, consumedFromSelection);

        let summary = injected.expandedSummary;
        summary = appendProtectedUserMessages(summary, plan.selection, ctx, state, config.compress.protectUserMessages);
        summary = appendProtectedPromptInfo(summary, plan.selection, ctx, state, config.compress.protectTags);
        summary = appendProtectedTools(summary, plan.selection, ctx, state, [...protectedTools], config.protectedFilePatterns);
        const completed = appendMissingBlockSummaries(summary, missing, ctx.summaryByBlockId, injected.consumedBlockIds);

        const blockId = allocateBlockId(state);
        const stored = wrapCompressedSummary(blockId, completed.expandedSummary, formatBlockRef, formatMessageIdTag);
        const summaryTokens = countTokens(stored);

        const applied = applyCompressionState(
          state,
          {
            topic: args.topic,
            batchTopic: args.topic,
            startId: plan.entry.startId,
            endId: plan.entry.endId,
            mode: "range",
            runId,
            compressCallId: toolCallId,
            summaryTokens,
          },
          plan.selection,
          plan.anchorMessageId,
          blockId,
          stored,
          completed.consumedBlockIds,
        );

        totalCompressed += applied.messageIds.length;
        notifications.push({ blockId, summary: completed.expandedSummary, summaryTokens });
        logger.info("Compressed range", { blockId, topic: args.topic, messages: applied.messageIds.length });
      }

      persist();

      const blockRefs = notifications.map((n) => formatBlockRef(n.blockId)).join(", ");
      return {
        content: [{ type: "text", text: `Compressed ${totalCompressed} messages into ${notifications.length} summary block(s): ${blockRefs}.` } satisfies ContentBlock],
        details: { topic: args.topic, blocks: notifications.map((n) => ({ blockId: n.blockId, summaryTokens: n.summaryTokens })) },
      };
    },
  };
}
