/**
 * Deduplication strategy — prune older tool calls that share an identical
 * (tool name + normalized parameters) signature, keeping only the most recent
 * occurrence. Pure state mutation: marks tool_use ids in `state.prune.tools`.
 *
 * Adapted from DCP's `lib/strategies/deduplication.ts`; operates on the
 * `tool_use.id`-keyed metadata built by `messages/query.buildToolMetadata`.
 */

import type { PluginConfig } from "../config";
import { DEFAULT_PROTECTED_TOOLS } from "../config";
import type { SessionState } from "../state/types";
import type { Logger } from "../logger";
import { getFilePathsFromParameters, isFilePathProtected, isToolNameProtected } from "../protected-patterns";

function effectiveProtected(config: PluginConfig, extra: string[]): Set<string> {
  return new Set([...DEFAULT_PROTECTED_TOOLS, ...extra]);
}

function normalizeParameters(params: unknown): unknown {
  if (typeof params !== "object" || params === null) return params;
  if (Array.isArray(params)) return params;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function sortObjectKeys(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    out[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }
  return out;
}

function createToolSignature(tool: string, parameters: unknown): string {
  const sorted = sortObjectKeys(normalizeParameters(parameters));
  return `${tool}::${JSON.stringify(sorted)}`;
}

export function deduplicate(state: SessionState, config: PluginConfig, logger: Logger): void {
  if (state.manualMode && !config.manualMode.automaticStrategies) return;
  if (!config.strategies.deduplication.enabled) return;

  const allToolIds = state.toolIdList;
  if (allToolIds.length === 0) return;

  const unprunedIds = allToolIds.filter((id) => !state.prune.tools.has(id));
  if (unprunedIds.length === 0) return;

  const protectedTools = effectiveProtected(config, config.strategies.deduplication.protectedTools);
  const signatureMap = new Map<string, string[]>();

  for (const id of unprunedIds) {
    const metadata = state.toolParameters.get(id);
    if (!metadata) continue;
    if (isToolNameProtected(metadata.tool, [...protectedTools])) continue;
    const filePaths = getFilePathsFromParameters(metadata.tool, metadata.parameters);
    if (isFilePathProtected(filePaths, config.protectedFilePatterns)) continue;

    const signature = createToolSignature(metadata.tool, metadata.parameters);
    const bucket = signatureMap.get(signature);
    if (bucket) bucket.push(id);
    else signatureMap.set(signature, [id]);
  }

  const newPruneIds: string[] = [];
  for (const ids of signatureMap.values()) {
    if (ids.length > 1) newPruneIds.push(...ids.slice(0, -1)); // keep most recent
  }

  if (newPruneIds.length === 0) return;

  for (const id of newPruneIds) {
    const entry = state.toolParameters.get(id);
    state.prune.tools.set(id, entry?.tokenCount ?? 0);
    state.stats.pruneTokenCounter += entry?.tokenCount ?? 0;
  }
  state.stats.totalPruneTokens += state.stats.pruneTokenCounter;
  state.stats.pruneTokenCounter = 0;
  logger.debug(`Marked ${newPruneIds.length} duplicate tool calls for pruning`);
}
