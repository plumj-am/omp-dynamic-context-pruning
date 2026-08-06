/**
 * Smoke test — exercises the core DCP pipeline against synthetic omp messages.
 * Run: bun smoke-test.ts
 */
import { createSessionState } from "./src/state/state";
import { buildToolMetadata, countUserTurns } from "./src/messages/query";
import { assignMessageRefs } from "./src/messages/identity";
import { prune } from "./src/messages/prune";
import { deduplicate } from "./src/strategies/deduplication";
import { purgeErrors } from "./src/strategies/purge-errors";
import { applyCompressionState, wrapCompressedSummary, allocateRunId, allocateBlockId } from "./src/state/utils";
import { buildRangeContext, resolveRanges, validateNonOverlapping, foldConsumedBlocks } from "./src/compress/range-utils";
import { injectSystemPrompt } from "./src/hooks";
import { DEFAULT_CONFIG } from "./src/config";
import { Logger } from "./src/logger";
import { estimateMessagesTokens } from "./src/token-utils";

const logger = new Logger(false);
let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

// Synthetic omp conversation
function txt(t: string) { return { type: "text", text: t }; }
function tu(id: string, name: string, input: unknown) { return { type: "tool_use", id, name, input }; }
function tr(id: string, text: string, isError = false) {
  return { type: "tool_result", tool_use_id: id, content: [txt(text)], is_error: isError } as const;
}

const state = createSessionState();
const messages = [
  { role: "user", content: [txt("Please read the config file.")] },
  { role: "assistant", content: [tu("toolu_1", "read", { path: "config.json" })] },
  { role: "user", content: [tr("toolu_1", "{ \"debug\": true }")] },
  { role: "assistant", content: [txt("Got it."), tu("toolu_2", "read", { path: "config.json" })] },
  { role: "user", content: [tr("toolu_2", "{ \"debug\": true }")] }, // duplicate of toolu_1
  { role: "assistant", content: [tu("toolu_3", "bash", { command: "rm -rf /" })] },
  { role: "user", content: [tr("toolu_3", "permission denied", true)] }, // errored
  { role: "assistant", content: [txt("Done.")] },
];

// 1. tool metadata + turns
buildToolMetadata(state, messages);
assert(state.toolIdList.length === 3, "toolIdList has 3 tool_use ids");
assert(state.toolParameters.get("toolu_3")?.status === "error", "toolu_3 marked error");
assert(countUserTurns(messages) === 4, "4 user turns");

// 2. dedup marks the older identical read (toolu_1)
deduplicate(state, DEFAULT_CONFIG, logger);
assert(state.prune.tools.has("toolu_1"), "dedup marked older duplicate toolu_1");
assert(!state.prune.tools.has("toolu_2"), "dedup kept most recent toolu_2");

// purge-errors: toolu_3 errored, age 0 turns (currentTurn 0) -> not yet. Bump turn.
state.currentTurn = 10;
state.prune.tools = new Map();
deduplicate(state, DEFAULT_CONFIG, logger);
purgeErrors(state, DEFAULT_CONFIG, logger);
assert(state.prune.tools.has("toolu_1"), "dedup still marks toolu_1");
assert(state.prune.tools.has("toolu_3"), "purgeErrors marks errored toolu_3 (old enough)");

// 3. prune replaces tool_result content for pruned ids
state.prune.tools = new Map();
state.prune.tools.set("toolu_1", 10);
state.prune.tools.set("toolu_3", 10);
const clone = messages.map((m) => ({ ...m, content: [...m.content] }));
assignMessageRefs(state, clone);
const pruned = prune(state, logger, DEFAULT_CONFIG, clone);
const tr1 = pruned[2].content[0] as { content: { text: string }[] };
assert(/Output removed/.test(tr1.content[0].text), "pruned toolu_1 result replaced with placeholder");

// 4. NO inline tags — the leak fix. Messages must carry no <dcp-message-id>.
assert(!/<dcp-message-id>/.test(JSON.stringify(pruned)), "no <dcp-message-id> tags leak into context");

// 5-6. compression via CONTENT ANCHORS (verbatim phrase substring match).
state.prune.tools = new Map();
state.prune.messages.byMessageId = new Map();
state.prune.messages.blocksById = new Map();
state.prune.messages.activeBlockIds = new Set();
state.prune.messages.activeByAnchorMessageId = new Map();

const work = messages.map((m) => ({ ...m, content: m.content.map((b) => structuredClone(b)) }));
assignMessageRefs(state, work); // no-op for citation now; kept for state consistency
assert(!/<dcp-message-id>/.test(JSON.stringify(work)), "no tags injected into context");

const ctx = buildRangeContext(work, state);
// anchors: "config.json" (first read, idx1) .. "denied" (errored result, idx6)
const args = {
  topic: "Initial exploration",
  content: [{ startAnchor: "config.json", endAnchor: "denied", summary: "Explored config.json; it has debug:true. A duplicate read and a failed rm were attempted." }],
};
const plans = resolveRanges(args, ctx);
validateNonOverlapping(plans);
assert(plans[0].selection.startIndex === 1, "startAnchor located the first read message");
assert(plans[0].selection.endIndex === 6, "endAnchor located the errored result");
assert(plans[0].selection.messageIds.length >= 5, "range selection spans the expected messages");

const runId = allocateRunId(state);
const blockId = allocateBlockId(state);
const stored = wrapCompressedSummary(args.topic, plans[0].entry.summary);
applyCompressionState(state, { topic: args.topic, batchTopic: args.topic, startId: plans[0].entry.startAnchor, endId: plans[0].entry.endAnchor, mode: "range", runId, summaryTokens: 30 }, plans[0].selection, plans[0].anchorMessageId, blockId, stored, plans[0].selection.requiredBlockIds);
assert(state.prune.messages.activeBlockIds.size === 1, "one active compression block");

// prune injects the summary (readable header) at the earliest effective message
// and elides the compressed span — on a fresh rebuild from originals.
const rebuild = messages.map((m) => ({ ...m, content: m.content.map((b) => structuredClone(b)) }));
const pruned2 = prune(state, logger, DEFAULT_CONFIG, rebuild);
const rendered = JSON.stringify(pruned2);
assert(/\[Compressed conversation section: Initial exploration\]/.test(rendered), "summary injected with readable header");
assert(!/"debug.:.true/.test(rendered), "compressed span content elided");
assert(!/<dcp-message-id>/.test(rendered), "pruned context has no dcp-message-id tags");
console.log("\npruned2 tokens:", estimateMessagesTokens(pruned2));

// 7. C4: nested compression that includes the prior summary, cited by content
//    anchors. The prior block is auto-detected (content text match) and folded.
state.lastContextMessages = pruned2;
const nestedCtx = buildRangeContext(pruned2, state);
const nestedArgs = {
  topic: "Wrap-up including prior block",
  content: [{ startAnchor: "Explored config.json", endAnchor: "Done.", summary: "Final wrap-up that also covers the earlier exploration block." }],
};
const nestedPlans = resolveRanges(nestedArgs, nestedCtx);
validateNonOverlapping(nestedPlans);
assert(nestedPlans[0].selection.requiredBlockIds.includes(1), "C4: prior block 1 auto-detected in cited range");
const nestedFolded = foldConsumedBlocks(nestedPlans[0].entry.summary, nestedPlans[0].selection.requiredBlockIds, nestedCtx.summaryByBlockId);
assert(nestedFolded.consumedBlockIds.includes(1), "C4: prior block 1 consumed/folded");
assert(/Explored config\.json/.test(nestedFolded.expandedSummary), "C4: prior block summary folded into new summary");
assert(/Final wrap-up/.test(nestedFolded.expandedSummary), "C4: new summary body preserved");
console.log("C4 nested consumed:", nestedFolded.consumedBlockIds);
// 8. Per-request system injection: the DCP system block is prepended to the
//    LLM-bound stream on every context pass (upstream parity), and is
//    idempotent - an existing system message is left alone.
const sysInjected = injectSystemPrompt(pruned2);
assert(sysInjected[0]?.role === "system", "system block prepended as first message");
assert(
  Array.isArray(sysInjected[0]?.content) &&
    typeof (sysInjected[0]?.content[0] as { text?: string })?.text === "string" &&
    /Dynamic Context Pruning/.test((sysInjected[0]?.content[0] as { text?: string })?.text ?? ""),
  "system block contains DCP guidance",
);
const sysInjected2 = injectSystemPrompt(sysInjected);
assert(sysInjected2.length === sysInjected.length, "system injection idempotent (no duplicate block)");
