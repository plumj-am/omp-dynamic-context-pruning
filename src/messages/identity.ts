/**
 * Stable message identity and m-ref assignment for omp.
 *
 * omp messages carry no stable id, so identity is derived from content:
 *  - tool_use present     → "tu:" + tool_use.id   (provider id, unique, stable)
 *  - tool_result present  → "tr:" + tool_use_id   (pairs with the tool_use)
 *  - text-only            → "txt:" + role + hash(text) + ordinal
 *
 * `assignMessageRefs` walks the context messages in order, assigns deterministic
 * m0001.. refs (stable because message order is stable), and stashes the
 * ref→identity map in state. The model cites ranges by content anchors, not by
 * these refs — they are kept for state consistency and tool internals.
 */

import type { AgentMessage, ContentBlock } from "../omp";
import type { SessionState } from "../state/types";
import { isToolUseBlock, isToolResultBlock, isTextBlock } from "./shape";
import { isIgnoredUserMessage } from "./query";

export const MESSAGE_REF_REGEX = /^m(\d{4})$/;
export const MESSAGE_ID_TAG_NAME = "dcp-message-id";

const MESSAGE_REF_WIDTH = 4;
const MESSAGE_REF_MIN_INDEX = 1;
export const MESSAGE_REF_MAX_INDEX = 9999;

export type ParsedBoundaryId = { kind: "message"; ref: string; index: number };

export function formatMessageRef(index: number): string {
  if (!Number.isInteger(index) || index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX) {
    throw new Error(`Message ref index out of bounds: ${index}`);
  }
  return `m${index.toString().padStart(MESSAGE_REF_WIDTH, "0")}`;
}

export function parseMessageRef(ref: string): number | null {
  const match = ref.trim().toLowerCase().match(MESSAGE_REF_REGEX);
  if (!match) return null;
  const index = Number.parseInt(match[1], 10);
  if (index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX) return null;
  return index;
}

export function parseBoundaryId(id: string): ParsedBoundaryId | null {
  const normalized = id.trim().toLowerCase();
  const messageIndex = parseMessageRef(normalized);
  if (messageIndex !== null) return { kind: "message", ref: formatMessageRef(messageIndex), index: messageIndex };
  return null;
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatMessageIdTag(ref: string, attributes?: Record<string, string | undefined>): string {
  const serialized = (Object.entries(attributes ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => {
      if (name.trim().length === 0 || typeof value !== "string" || value.length === 0) return "";
      return ` ${name}="${escapeXmlAttribute(value)}"`;
    }) as string[])
    .join("");
  return `\n<${MESSAGE_ID_TAG_NAME}${serialized}>${ref}</${MESSAGE_ID_TAG_NAME}>`;
}

/** djb2 string hash → base36, compact and stable. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function messageTextSignature(msg: AgentMessage): string {
  if (!Array.isArray(msg.content)) return "";
  let sig = "";
  for (const b of msg.content) if (isTextBlock(b)) sig += b.text;
  // Strip any injected <dcp-message-id> tags so identity is stable across the
  // tag-injection step (assignMessageRefs computes identities before injecting
  // the tag into text; without stripping, text-message identities would shift
  // after the tag is appended).
  return sig.replace(/\n?<dcp-message-id>[^<]*<\/dcp-message-id>/g, "");
}

/**
 * Compute a stable identity for a single message. For text-only messages the
 * caller must supply an `ordinal` to disambiguate duplicates (see
 * assignMessageRefs, which computes ordinals in a stable first pass).
 */
export function messageIdentity(msg: AgentMessage, textOrdinal?: number): string {
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) if (isToolUseBlock(b)) return `tu:${b.id}`;
    for (const b of msg.content) if (isToolResultBlock(b)) return `tr:${b.tool_use_id}`;
  }
  const ord = Number.isInteger(textOrdinal) ? textOrdinal : 0;
  return `txt:${msg.role}:${hash(messageTextSignature(msg))}:${ord}`;
}

/**
 * First pass: assign ordinals to text-only messages so duplicate text gets
 * distinct but stable identities.
 */
function computeTextOrdinals(messages: AgentMessage[]): Map<number, number> {
  const counts = new Map<string, number>();
  const result = new Map<number, number>();
  messages.forEach((msg, i) => {
    if (msg.role === "user" && isIgnoredUserMessage(msg)) return;
    if (Array.isArray(msg.content) && (msg.content.some((b) => isToolUseBlock(b)) || msg.content.some((b) => isToolResultBlock(b)))) return;
    const base = `${msg.role}:${hash(messageTextSignature(msg))}`;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    result.set(i, n);
  });
  return result;
}

function hasRelevantContent(msg: AgentMessage): boolean {
  if (!Array.isArray(msg.content) || msg.content.length === 0) return false;
  return msg.content.some((b) => isToolUseBlock(b) || isToolResultBlock(b) || isTextBlock(b));
}

/**
 * Compute a stable identity for every message index. Skipped messages
 * (ignored user messages, the first sub-agent prompt, no relevant content)
 * get the empty string. Both `assignMessageRefs` and the prune core use this
 * so identity stays consistent across the two passes.
 */
export function computeIdentities(messages: AgentMessage[], isSubAgent: boolean): string[] {
  const ordinals = computeTextOrdinals(messages);
  const identities: string[] = new Array(messages.length).fill("");
  let skippedSubAgentPrompt = false;
  messages.forEach((msg, i) => {
    if (msg.role === "user" && isIgnoredUserMessage(msg)) return;
    if (isSubAgent && !skippedSubAgentPrompt && msg.role === "user") {
      skippedSubAgentPrompt = true;
      return;
    }
    if (!hasRelevantContent(msg)) return;
    identities[i] = messageIdentity(msg, ordinals.get(i));
  });
  return identities;
}

/**
 * Build the positional ref→identity map (m0001 = oldest message, m0002 = next,
 * …) and stash it in state for the compress tool to resolve model-cited ranges.
 *
 * IMPORTANT: no tags are injected into message text. An earlier version
 * appended `<dcp-message-id>` tags inline, but omp surfaces the context-hook
 * output into the display transcript, so the tags leaked to the user and
 * accumulated across turns. The model now cites ranges by positional count
 * (described in the compress prompt) — zero leakage, no accumulation.
 *
 * Does NOT mutate `messages`.
 */
export function assignMessageRefs(state: SessionState, messages: AgentMessage[]): number {
  const identities = computeIdentities(messages, state.isSubAgent);
  state.messageIds.byRef = new Map();
  state.messageIds.byRawId = new Map();
  state.messageIds.nextRef = 1;

  let assigned = 0;
  let refIndex = 0;
  for (let i = 0; i < messages.length; i++) {
    const identity = identities[i];
    if (!identity) continue;
    refIndex += 1;
    if (refIndex > MESSAGE_REF_MAX_INDEX) break;
    const ref = formatMessageRef(refIndex);
    state.messageIds.byRef.set(ref, identity);
    state.messageIds.byRawId.set(identity, ref);
    assigned += 1;
  }
  state.messageIds.nextRef = refIndex + 1;
  return assigned;
}

/** Resolve a model-supplied ref (m0001) to an identity, using stashed map. */
export function refToIdentity(state: SessionState, ref: string): string | null {
  const parsed = parseBoundaryId(ref);
  if (!parsed) return null;
  return state.messageIds.byRef.get(parsed.ref) ?? null;
}
