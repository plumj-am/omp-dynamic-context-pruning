/**
 * The compress tool (range mode). The model authors the summaries; this tool
 * validates ranges, nests prior compressions, appends protected content, and
 * stores compression blocks in session state.
 *
 * Registered via `pi.registerTool`. Dependencies (state/logger/config/zod/persist)
 * are captured in a factory closure.
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolResult, ContentBlock } from "../omp";
import type { PluginConfig } from "../config";
import type { Logger } from "../logger";
import type { SessionState } from "../state/types";
import { allocateBlockId, allocateRunId, applyCompressionState, wrapCompressedSummary } from "../state/utils";
import { formatBlockRef, formatMessageIdTag } from "../messages/identity";
import { countTokens } from "../token-utils";
import { DEFAULT_PROTECTED_TOOLS } from "../config";
import { appendMissingBlockSummaries, buildRangeContext, injectBlockPlaceholders, parseBlockPlaceholders, resolveRanges, validateArgs, validateNonOverlapping, validateSummaryPlaceholders } from "./range-utils";
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
    async execute(toolCallId, params, _signal, _onUpdate, execCtx): Promise<ToolResult> {
      const args = params as { topic: string; content: { startId: string; endId: string; summary: string }[] };
      validateArgs(args);

      const messages = state.lastContextMessages;
      if (!messages || messages.length === 0) {
        throw new Error("No context messages available to compress. Try again on a later turn.");
      }

      const rangeCtx = buildRangeContext(messages, state);
      const plans = resolveRanges(args, rangeCtx, state);
      validateNonOverlapping(plans);

      const protectedTools = new Set([...DEFAULT_PROTECTED_TOOLS, ...config.compress.protectedTools]);
      const runId = allocateRunId(state);
      const entries: { blockId: number; summary: string; summaryTokens: number; compressedTokens: number }[] = [];
      let totalCompressed = 0;

      for (const plan of plans) {
        const placeholders = parseBlockPlaceholders(plan.entry.summary);
        const missing = validateSummaryPlaceholders(placeholders, plan.selection.requiredBlockIds, plan.selection.startReference, plan.selection.endReference, rangeCtx.summaryByBlockId);
        const injected = injectBlockPlaceholders(plan.entry.summary, placeholders, rangeCtx.summaryByBlockId, plan.selection.startReference, plan.selection.endReference);

        let summary = injected.expandedSummary;
        summary = appendProtectedUserMessages(summary, plan.selection, rangeCtx, state, config.compress.protectUserMessages);
        summary = appendProtectedPromptInfo(summary, plan.selection, rangeCtx, state, config.compress.protectTags);
        summary = appendProtectedTools(summary, plan.selection, rangeCtx, state, [...protectedTools], config.protectedFilePatterns);
        const completed = appendMissingBlockSummaries(summary, missing, rangeCtx.summaryByBlockId, injected.consumedBlockIds);

        const blockId = allocateBlockId(state);
        const stored = wrapCompressedSummary(blockId, completed.expandedSummary, formatBlockRef, formatMessageIdTag);
        const summaryTokens = countTokens(stored);

        const applied = applyCompressionState(
          state,
          { topic: args.topic, batchTopic: args.topic, startId: plan.entry.startId, endId: plan.entry.endId, mode: "range", runId, compressCallId: toolCallId, summaryTokens },
          plan.selection,
          plan.anchorMessageId,
          blockId,
          stored,
          completed.consumedBlockIds,
        );

        totalCompressed += applied.messageIds.length;
        entries.push({ blockId, summary: completed.expandedSummary, summaryTokens, compressedTokens: applied.compressedTokens });
        logger.info("Compressed range", { blockId, topic: args.topic, messages: applied.messageIds.length });
      }

      persist();
      notifyCompression(execCtx, config, args.topic, entries, totalCompressed);

      const blockRefs = entries.map((e) => formatBlockRef(e.blockId)).join(", ");
      return {
        content: [{ type: "text", text: `Compressed ${totalCompressed} messages into ${entries.length} summary block(s): ${blockRefs}.` } satisfies ContentBlock],
        details: { topic: args.topic, blocks: entries.map((e) => ({ blockId: e.blockId, summaryTokens: e.summaryTokens })) },
      };
    },
  };
}

interface CompressEntry {
  blockId: number;
  summary: string;
  summaryTokens: number;
  compressedTokens: number;
}

/**
 * Surface a compress result via omp's UI notification. Honors `pruneNotification`:
 * "off" → silent, "minimal" → one-line metrics, "detailed" → adds topic + block
 * refs (+ summary preview when `compress.showCompression`). omp has a single
 * notify surface, so `pruneNotificationType` ("chat" vs "toast") maps to the
 * same `ctx.ui.notify` call.
 */
function notifyCompression(
  execCtx: ExtensionContext,
  config: PluginConfig,
  topic: string,
  entries: CompressEntry[],
  totalMessages: number,
): void {
  if (config.pruneNotification === "off" || entries.length === 0) return;
  if (!execCtx || !execCtx.ui || typeof execCtx.ui.notify !== "function") return;

  const reclaimed = entries.reduce((sum, e) => sum + e.compressedTokens, 0);
  const summaryTokens = entries.reduce((sum, e) => sum + e.summaryTokens, 0);
  const blockRefs = entries.map((e) => formatBlockRef(e.blockId)).join(", ");

  let message: string;
  if (config.pruneNotification === "minimal") {
    message = `DCP: compressed ${totalMessages} message(s) into ${entries.length} block(s) [${topic}] — ~${reclaimed.toLocaleString()} tokens reclaimed, +${summaryTokens.toLocaleString()} summary`;
  } else {
    message = `DCP compression [${topic}]`;
    message += `\n→ blocks: ${blockRefs} | messages: ${totalMessages}`;
    message += `\n→ ~${reclaimed.toLocaleString()} tokens reclaimed, +${summaryTokens.toLocaleString()} summary`;
    if (config.compress.showCompression && entries.length === 1) {
      const preview = entries[0]!.summary.slice(0, 600);
      message += `\n→ summary: ${preview}${entries[0]!.summary.length > 600 ? "…" : ""}`;
    }
  }

  try {
    execCtx.ui.notify(message, "info");
  } catch {
    /* notifications must never break compression */
  }
}
