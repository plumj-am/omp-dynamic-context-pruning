/**
 * Prompt bodies for DCP. Plain-text constants; the system block is appended to
 * the system prompt, the compress-range body is the compress tool description,
 * and the nudge bodies are injected into context when thresholds are crossed.
 */

/** Appended to the system prompt so the model knows about DCP + the compress tool. */
export const SYSTEM_PROMPT_BLOCK = `# Dynamic Context Pruning (DCP)

A \`compress\` tool is available. Use it to replace closed, stale stretches of conversation with a high-fidelity technical summary, reclaiming context for the work ahead. Compression is surgical and lossless-by-design: protected tool outputs and protected file operations are appended into the summary automatically, and nested compressions are preserved through layers.

When to compress:
- After a distinct sub-task completes (a feature landed, an investigation resolved, a refactor merged) and the verbatim back-and-forth is no longer needed.
- When context is filling up and older turns are no longer load-bearing.
- Prefer compressing whole coherent spans, not fragments.

How to compress (range mode):
- Each conversation message carries a trailing \`<dcp-message-id>m####</dcp-message-id>\` tag. Compressed spans carry \`<dcp-message-id>b#</dcp-message-id>\`.
- Call \`compress\` with one or more ranges, each giving \`startId\` / \`endId\` (m#### or b# refs) and a \`summary\` you write yourself — a complete, faithful technical record of everything in that span (decisions, code changes, file paths, results, open questions). Future turns depend on this summary; be thorough.
- If a range fully contains an earlier compressed block, reference it inline as \`(b#)\` and DCP nests the prior summary into yours.
- Never compress across the current active turn or content you still need verbatim.

The session history is never modified — compression only reshapes what is sent to you. Summaries replace spans in your context; the underlying record stays intact.`;

/** The compress tool description shown in the tool list. */
export const COMPRESS_RANGE_PROMPT = `Compress one or more ranges of the conversation into technical summaries, replacing the verbatim spans in context. You author each summary yourself. Each message in the conversation is tagged with a <dcp-message-id>m####</dcp-message-id> identifier and prior compressions with <dcp-message-id>b#</dcp-message-id>; cite those as range boundaries. Write summaries that fully preserve decisions, code changes, file paths, and outcomes — they are the only record future turns will have of the compressed span.`;

/** Format help appended to the tool description. */
export const RANGE_FORMAT_EXTENSION = `\n\nBoundary format: use m#### (e.g. m0003) for a conversation message, or b# (e.g. b2) for an existing compressed block. A range may fully contain earlier compressed blocks; reference them inline as (b#) in your summary and they will be nested automatically.`;

/** Strong nudge when context exceeds maxContextLimit. */
export const CONTEXT_LIMIT_NUDGE = `[context is near capacity — consider calling the compress tool to summarize completed, no-longer-needed spans before continuing]`;

/** Soft reminder after a user turn when context is above minContextLimit. */
export const TURN_NUDGE_SOFT = `[reminder: the compress tool is available to reclaim context from finished spans]`;
export const TURN_NUDGE_STRONG = `[context is growing — call the compress tool to summarize completed spans before taking on more work]`;

/** Iteration nudge after many tool turns without a user message. */
export const ITERATION_NUDGE = `[long tool loop without a user turn — if the recent tool work is settling, compress it to free context]`;
