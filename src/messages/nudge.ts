/**
 * Compress-nudge injection. Appends short, non-repeating reminders to the
 * latest user message when context crosses the configured thresholds. Nudges
 * are anchored to the latest user-message identity so each anchor nudges at
 * most once per kind.
 */

import type { AgentMessage, ContentBlock } from "../omp";
import type { SessionState } from "../state/types";
import type { PluginConfig } from "../config";
import { CONTEXT_LIMIT_NUDGE, ITERATION_NUDGE, TURN_NUDGE_SOFT, TURN_NUDGE_STRONG } from "../prompts";
import { isTextBlock } from "./shape";
import { isIgnoredUserMessage } from "./query";

function resolveLimit(value: number | `${number}%`, modelLimit: number | undefined): number {
  if (typeof value === "string") {
    const pct = Number.parseFloat(value);
    const base = modelLimit && modelLimit > 0 ? modelLimit : 200000;
    return Math.round((base * pct) / 100);
  }
  return value;
}

function lastUserIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !isIgnoredUserMessage(messages[i])) return i;
  }
  return -1;
}

function appendToUserMessage(msg: AgentMessage, text: string): void {
  if (!Array.isArray(msg.content)) {
    msg.content = [{ type: "text", text } satisfies ContentBlock];
    return;
  }
  for (let j = msg.content.length - 1; j >= 0; j--) {
    const block = msg.content[j];
    if (isTextBlock(block)) {
      block.text = `${block.text}\n${text}`;
      return;
    }
  }
  msg.content.push({ type: "text", text } satisfies ContentBlock);
}

/**
 * Decide and inject nudges. `tokens` is the estimated token count of the
 * context about to be sent. `fetchCount` is a monotonic per-session counter
 * the caller increments on every context pass (used for nudgeFrequency).
 */
export function injectCompressNudges(
  state: SessionState,
  config: PluginConfig,
  tokens: number,
  messages: AgentMessage[],
  fetchCount: number,
): void {
  if (state.manualMode) return;
  const maxLimit = resolveLimit(config.compress.maxContextLimit, state.modelContextLimit);
  const minLimit = resolveLimit(config.compress.minContextLimit, state.modelContextLimit);

  const userIdx = lastUserIndex(messages);
  if (userIdx < 0) return;
  const anchor = `idx:${userIdx}`; // stable per position this pass

  // context-limit nudge: strong, throttled by nudgeFrequency
  if (tokens >= maxLimit && fetchCount % Math.max(1, config.compress.nudgeFrequency) === 0) {
    if (!state.nudges.contextLimitAnchors.has(anchor)) {
      appendToUserMessage(messages[userIdx], CONTEXT_LIMIT_NUDGE);
      state.nudges.contextLimitAnchors.add(anchor);
      return;
    }
  }

  // turn nudge: above minLimit after a user turn (one per anchor)
  if (tokens >= minLimit && !state.nudges.turnNudgeAnchors.has(anchor)) {
    const body = config.compress.nudgeForce === "strong" ? TURN_NUDGE_STRONG : TURN_NUDGE_SOFT;
    appendToUserMessage(messages[userIdx], body);
    state.nudges.turnNudgeAnchors.add(anchor);
    return;
  }

  // iteration nudge: many tool turns since the last user message
  let toolTurnsSinceUser = 0;
  for (let i = messages.length - 1; i > userIdx; i--) {
    const content = Array.isArray(messages[i].content) ? messages[i].content : [];
    if (content.some((b) => (b as { type?: string }).type === "tool_use" || (b as { type?: string }).type === "tool_result")) {
      toolTurnsSinceUser++;
    }
  }
  if (toolTurnsSinceUser >= config.compress.iterationNudgeThreshold && !state.nudges.iterationNudgeAnchors.has(anchor)) {
    appendToUserMessage(messages[userIdx], ITERATION_NUDGE);
    state.nudges.iterationNudgeAnchors.add(anchor);
  }
}
