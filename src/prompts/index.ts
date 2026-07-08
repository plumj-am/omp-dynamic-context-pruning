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
- Cite a range by quoting a short, distinctive phrase **verbatim** from its first message (\`startAnchor\`) and its last message (\`endAnchor\`). Pick phrases unique enough to identify those messages — the tool locates them by substring match (whitespace- and case-insensitive).
- Call \`compress\` with one or more ranges, each giving a \`summary\` you write yourself — a complete, faithful technical record of everything in that span (decisions, code changes, file paths, results, open questions). Future turns depend on this summary; be thorough.
- A prior compressed span appears in your context as a single message beginning with \`[Compressed conversation section · b<N>]\`. To compress a range that includes it, just anchor your range before/after or on its text — the tool auto-detects and folds prior summaries into yours. You do not need to reference block ids.
- Never compress across the current active turn or content you still need verbatim.

The session history is never modified — compression only reshapes what is sent to you. Summaries replace spans in your context; the underlying record stays intact.`;

/** The compress tool description shown in the tool list. */
export const COMPRESS_RANGE_PROMPT = `Compress one or more ranges of the conversation into technical summaries, replacing the verbatim spans in context. You author each summary yourself. Cite each range with a startAnchor and endAnchor — short verbatim phrases quoted from the first and last messages of the range (the tool locates them by substring match). Write summaries that fully preserve decisions, code changes, file paths, and outcomes — they are the only record future turns will have of the compressed span.`;

/** Format help appended to the tool description. */
export const RANGE_FORMAT_EXTENSION = `\n\nAnchors: quote 3-30 word phrases that appear verbatim in the target messages (matched case- and whitespace-insensitively). Choose distinctive phrases — avoid generic text that recurs. Prior compressed sections (their \`[Compressed conversation section · b#]\` messages) inside a cited range are detected and folded automatically.`;

/** Strong nudge when context exceeds maxContextLimit. */
export const CONTEXT_LIMIT_NUDGE = `[context is near capacity — consider calling the compress tool to summarize completed, no-longer-needed spans before continuing]`;

/** Soft reminder after a user turn when context is above minContextLimit. */
export const TURN_NUDGE_SOFT = `[reminder: the compress tool is available to reclaim context from finished spans]`;
export const TURN_NUDGE_STRONG = `[context is growing — call the compress tool to summarize completed spans before taking on more work]`;

/** Iteration nudge after many tool turns without a user message. */
export const ITERATION_NUDGE = `[long tool loop without a user turn — if the recent tool work is settling, compress it to free context]`;
