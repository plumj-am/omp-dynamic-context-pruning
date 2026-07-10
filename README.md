# omp-dynamic-context-pruning

Dynamic Context Pruning for [Oh My Pi (omp)](https://omp.ai), modeled on
[Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning).

It shrinks what gets sent to the LLM by **compressing closed stretches of
conversation into summaries** and **pruning superseded / errored tool output** —
**without ever modifying your session history**. All transforms happen on the
copy of the conversation bound for the LLM; the persisted session stays
byte-for-byte intact.

Because omp counts context from the provider's real prompt-token report, the
savings are real: the context bar drops and omp's auto-compaction is deferred.

## What it does

- **`compress` tool** — the model calls it to replace a finished span with a
  high-fidelity technical summary **it writes itself**. Surgical and
  lossless-by-design: protected tool outputs and protected file operations are
  appended into the summary automatically, and nested compressions are folded
  through layers.
- **Deduplication** — drops older tool calls that repeat the same tool + args,
  keeping only the most recent output.
- **Purge-errors** — blanks the (potentially large) inputs of errored tool calls
  after a configurable number of turns; the error message itself is preserved.
- **Context nudges** — short, non-repeating reminders to compress when context
  approaches capacity.

## How it works

Every provider request fires omp's `context` event (confirmed LLM-only in
`pi-agent-core/src/agent-loop.ts` — the transform output goes to the provider
and is never written back to storage or the display transcript). On a clone of
the messages, DCP:

1. rebuilds tool metadata (correlating `tool_use` ↔ `tool_result`),
2. runs deduplication + purge-errors (marking tool ids to blank),
3. replaces superseded/errored tool content with placeholders and injects
   compression summaries in place of their spans,
4. injects a compress nudge when thresholds are crossed.

When the model calls `compress`, it authors the summary; DCP locates the cited
range, folds any prior compressions nested inside, appends protected content,
and stores a compression block in session state (persisted via omp custom
entries, reconstructed on session resume).

### Range citation: content anchors (an omp-specific design choice)

Upstream DCP tags every message with `<dcp-message-id>m####</dcp-message-id>` so
the model can cite ranges by stable id. **That does not work in omp.** omp has
no hook to mutate assistant output before it is persisted/displayed (all
`message_*` lifecycle events are notification-only), so upstream's
`stripHallucinations` defense is unavailable — and any visible tag pattern gets
imitated by the model into its own output, polluting the transcript.

So this port uses **content anchors**: the model cites a range by quoting a
short verbatim phrase from its first message (`startAnchor`) and its last
(`endAnchor`). DCP locates each anchor by substring match (whitespace- and
case-insensitive) and takes the span between them. **Nothing is injected into
context**, so there is nothing for the model to imitate. Prior compressed
sections inside a cited range are auto-detected by matching their summary
text against active blocks and folded.

## Installation

This is a source extension (a directory with `package.json` declaring
`omp.extensions`). Add it to your omp config:

```yaml
# ~/.omp/agent/config.yml   (or <project>/.omp/config.yml)
extensions:
  - /path/to/omp-dynamic-context-pruning
```

Restart omp. You should see `Dynamic Context Pruning` among the loaded
extensions, a `compress` tool available to the model, and the `/dcp` commands.

## Configuration

DCP reads its own config, searched in order (later wins):

1. `~/.omp/agent/dcp.jsonc` (or `dcp.json`)
2. `<cwd>/.omp/dcp.jsonc` (or `dcp.json`)

Restart omp after editing. Defaults are applied automatically — you only need a
config file to override.

```jsonc
{
  "enabled": true,
  "debug": false,
  "pruneNotification": "detailed",        // "off" | "minimal" | "detailed"
  "commands": { "enabled": true, "protectedTools": [] },
  "manualMode": { "enabled": false, "automaticStrategies": true },
  "turnProtection": { "enabled": false, "turns": 4 },
  "experimental": { "allowSubAgents": false, "customPrompts": false },
  "protectedFilePatterns": [],            // globs matching tool filePath/path args
  "compress": {
    "mode": "range",                      // "range" (stable); "message" is experimental upstream
    "permission": "allow",                // "allow" | "ask" | "deny"
    "showCompression": false,
    "summaryBuffer": true,
    "maxContextLimit": 100000,            // number or "X%" of context window
    "minContextLimit": 50000,
    "nudgeFrequency": 5,
    "iterationNudgeThreshold": 15,
    "nudgeForce": "soft",                 // "strong" | "soft"
    "protectedTools": ["task", "skill", "todowrite", "todoread"],
    "protectTags": false,                 // preserve <protect>...</protect> spans
    "protectUserMessages": false          // preserve user messages verbatim
  },
  "strategies": {
    "deduplication": { "enabled": true, "protectedTools": [] },
    "purgeErrors": { "enabled": true, "turns": 4, "protectedTools": [] }
  }
}
```

These tools are always protected from pruning: `task`, `skill`, `todowrite`,
`todoread`, `compress`, `batch`, `plan_enter`, `plan_exit`, `write`, `edit`. The
`protectedTools` arrays add to that list.

## Commands

- `/dcp` — overview and command help.
- `/dcp-compress [focus]` — ask the model to run one compression pass. Optional
  focus text directs what to compress.
- `/dcp stats` — pruning stats (tokens saved, active compressions, context size).
- `/dcp context` — current context token estimate vs. window.
- `/dcp manual on|off` — toggle manual mode (pauses autonomous pruning).

## Debug logs

With `"debug": true`, per-pass context snapshots and structured logs are written
under `~/.omp/agent/logs/dcp/`.

## Faithfulness to upstream DCP

A port of DCP's *core* to omp's extension API. Implemented: the `context`
transform (the heart), the `compress` tool (range mode, content anchors),
deduplication, purge-errors, system-prompt/nudge injection, protected tools +
file patterns, protected-content append, compress notifications, the config
system, state persistence, and slash commands.

Deliberately different from upstream (driven by omp's architecture, documented
here so the divergence is visible):

- **Content anchors instead of `<dcp-message-id>` tags** — omp has no
  output-mutation hook, so tag injection would pollute the transcript. See
  *Range citation* above.
- **No per-compress permission prompt** — omp's approval model differs; auto.
- **No subagent-result extension** — subagents are out of scope
  (`experimental.allowSubAgents` defaults false).

Not yet ported (the state model supports adding them without redesign):

- **`message` compress mode** — experimental upstream; range mode is the
  production default.
- **TUI panel** — OpenCode's panel system is host-specific; `/dcp` commands
  cover the same surface.
- **`/dcp sweep`, `recompress`, `decompress`** — secondary commands.

See [`docs/design.md`](./docs/design.md) for the full architecture, the
OpenCode → omp API mapping, and the message-identity design (omp messages carry
no stable id, so identity is derived from `tool_use.id` + content signatures).

## Verification

- `bunx tsc --noEmit` — type-checks clean.
- `bun smoke-test.ts` — exercises the full pipeline (dedup, purge-errors,
  placeholder pruning, content-anchor range resolution, compression-block
  storage, summary injection, nested-block folding) against synthetic omp
  messages.

## License

AGPL-3.0-or-later, matching upstream DCP. See [`LICENSE`](./LICENSE).
