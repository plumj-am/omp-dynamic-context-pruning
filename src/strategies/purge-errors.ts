/**
 * Purge-errors strategy — prune the *inputs* of errored tool calls once they
 * are older than a configurable number of turns. The error message itself is
 * preserved; only the potentially large input is removed.
 *
 * Pure state mutation: marks tool_use ids in `state.prune.tools`. The prune
 * core later replaces those ids' content with placeholders.
 */

import type { PluginConfig } from "../config";
import { DEFAULT_PROTECTED_TOOLS } from "../config";
import type { SessionState } from "../state/types";
import type { Logger } from "../logger";
import { getFilePathsFromParameters, isFilePathProtected, isToolNameProtected } from "../protected-patterns";

export function purgeErrors(state: SessionState, config: PluginConfig, logger: Logger): void {
  if (state.manualMode && !config.manualMode.automaticStrategies) return;
  if (!config.strategies.purgeErrors.enabled) return;

  const allToolIds = state.toolIdList;
  if (allToolIds.length === 0) return;

  const unprunedIds = allToolIds.filter((id) => !state.prune.tools.has(id));
  if (unprunedIds.length === 0) return;

  const protectedTools = new Set([...DEFAULT_PROTECTED_TOOLS, ...config.strategies.purgeErrors.protectedTools]);
  const turnThreshold = Math.max(1, config.strategies.purgeErrors.turns);
  const newPruneIds: string[] = [];

  for (const id of unprunedIds) {
    const metadata = state.toolParameters.get(id);
    if (!metadata) continue;
    if (metadata.status !== "error") continue;
    if (isToolNameProtected(metadata.tool, [...protectedTools])) continue;
    const filePaths = getFilePathsFromParameters(metadata.tool, metadata.parameters);
    if (isFilePathProtected(filePaths, config.protectedFilePatterns)) continue;

    const turnAge = state.currentTurn - metadata.turn;
    if (turnAge >= turnThreshold) newPruneIds.push(id);
  }

  if (newPruneIds.length === 0) return;

  for (const id of newPruneIds) {
    const entry = state.toolParameters.get(id);
    state.prune.tools.set(id, entry?.tokenCount ?? 0);
    state.stats.pruneTokenCounter += entry?.tokenCount ?? 0;
  }
  state.stats.totalPruneTokens += state.stats.pruneTokenCounter;
  state.stats.pruneTokenCounter = 0;
  logger.debug(`Marked ${newPruneIds.length} error tool calls for pruning (older than ${turnThreshold} turns)`);
}
