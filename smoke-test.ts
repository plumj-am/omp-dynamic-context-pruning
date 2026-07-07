/**
 * Smoke test — exercises the core DCP pipeline against synthetic omp messages.
 * Run: bun smoke-test.ts
 */
import { createSessionState } from "./src/state/state";
import { buildToolMetadata, countUserTurns } from "./src/messages/query";
import { assignMessageRefs, formatBlockRef } from "./src/messages/identity";
import { prune } from "./src/messages/prune";
import { deduplicate } from "./src/strategies/deduplication";
import { purgeErrors } from "./src/strategies/purge-errors";
import { applyCompressionState, wrapCompressedSummary, allocateRunId, allocateBlockId } from "./src/state/utils";
import { buildRangeContext, resolveRanges, validateNonOverlapping, consumedBlockIdsIn } from "./src/compress/range-utils";
import { formatMessageIdTag } from "./src/messages/identity";
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

// 4. m-ref tags injected
assert(JSON.stringify(pruned).includes("<dcp-message-id>m0001"), "m-ref tag injected");

// 5-6. compression flow on ONE consistently-tagged copy (mirrors the real
// pipeline: assignMessageRefs tags, compress tool reads lastContextMessages,
// prune recomputes identities on the same tagged messages).
state.prune.tools = new Map();
state.prune.messages.byMessageId = new Map();
state.prune.messages.blocksById = new Map();
state.prune.messages.activeBlockIds = new Set();
state.prune.messages.activeByAnchorMessageId = new Map();

const work = messages.map((m) => ({ ...m, content: [...m.content] }));
assignMessageRefs(state, work); // tags `work`, builds ref→identity
state.lastContextMessages = work;

const ctx = buildRangeContext(work, state);
const startIdentity = ctx.identities[1];
const endIdentity = ctx.identities[6];
assert(!!startIdentity && !!endIdentity, "identities resolved for range bounds");

const startRef = state.messageIds.byRawId.get(startIdentity);
const endRef = state.messageIds.byRawId.get(endIdentity);
assert(!!startRef && !!endRef, "refs resolved for range bounds");

const args = {
  topic: "Initial exploration",
  content: [{ startId: startRef!, endId: endRef!, summary: "Explored config.json; it has debug:true. A duplicate read and a failed rm were attempted." }],
};
const plans = resolveRanges(args, ctx, state);
validateNonOverlapping(plans);
assert(plans[0].selection.messageIds.length >= 5, "range selection spans the expected messages");

const runId = allocateRunId(state);
const blockId = allocateBlockId(state);
const stored = wrapCompressedSummary(blockId, plans[0].entry.summary, formatBlockRef, formatMessageIdTag);
applyCompressionState(state, { topic: args.topic, batchTopic: args.topic, startId: startRef!, endId: endRef!, mode: "range", runId, summaryTokens: 30 }, plans[0].selection, plans[0].anchorMessageId, blockId, stored, consumedBlockIdsIn(plans[0].selection, ctx));
assert(state.prune.messages.activeBlockIds.size === 1, "one active compression block");

const pruned2 = prune(state, logger, DEFAULT_CONFIG, work);
const rendered = JSON.stringify(pruned2);
assert(/Compressed conversation section/.test(rendered), "summary injected into pruned context");
assert(/Please read the config file/.test(rendered), "anchor user message preserved with summary");
assert(!/"debug.:.true/.test(rendered), "compressed span content elided");
console.log("\npruned2 tokens:", estimateMessagesTokens(pruned2));

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
