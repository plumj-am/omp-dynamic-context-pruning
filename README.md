# DCP for omp

Dynamic Context Pruning for [Oh My Pi (omp)](https://omp.ai), modeled on
[Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning).

Automatically reduces token usage by managing conversation context — **without
ever modifying your session history**. Pruned content is replaced with
placeholders or summaries only in the copy sent to the LLM; the persisted
session stays byte-for-byte intact.

## What it does

- **`compress` tool** — a tool the model can call to replace closed, stale
  stretches of conversation with a high-fidelity technical summary *it writes
  itself*. Surgical and lossless-by-design: protected tool outputs and protected
  file operations are appended into the summary automatically, and nested
  compressions are preserved through layers.
- **Deduplication** — drops older tool calls that repeat the same tool + args,
  keeping only the most recent output.
- **Purge-errors** — blanks the (potentially large) inputs of errored tool calls
  after a configurable number of turns; the error message is preserved.
- **Context nudges** — short, non-repeating reminders to compress when context
  approaches capacity.

## How it works

Every provider request fires omp's `context` event. DCP clones the messages and,
on that clone only:

1. rebuilds tool metadata (correlating `tool_use` ↔ `tool_result`),
2. runs deduplication + purge-errors (marking tool ids to blank),
3. assigns stable `m0001`/`b2` refs and injects `<dcp-message-id>` tags so the
   model can cite ranges,
4. replaces superseded/errored tool content with placeholders and injects
   compression summaries at their anchors,
5. injects a compress nudge when thresholds are crossed.

Storage is never touched. When the model calls `compress`, it authors the
summary; DCP validates the cited range, nests any prior compressions inside it,
appends protected content, and stores a compression block in session state
(persisted via omp custom entries, reconstructed on session resume).

## Installation

This is a source extension (a directory with `package.json` declaring
`omp.extensions`). Add it to your omp config:

```yaml
# ~/.omp/agent/config.yml   (or <project>/.omp/config.yml)
extensions:
  - D:/_omp_plugin/dcp
```

Restart omp. You should see `Dynamic Context Pruning` in the loaded extensions.

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

This is a port of DCP's *core* to omp's extension API. Implemented: the `context`
transform (the heart), the `compress` tool (range mode), deduplication,
purge-errors, system-prompt/nudge injection, protected tools + file patterns,
protected-content append, the config system, state persistence, and slash
commands.

Deferred (documented, not silently dropped):

- **`message` compress mode** — experimental upstream; range mode is the
  production default. The state model supports adding it later without redesign.
- **TUI panel** — OpenCode's panel system is host-specific; the `/dcp` commands
  cover the same surface.
- **npm auto-update** — the plugin is source-installed; update by pulling.
- **`/dcp sweep`, `recompress`, `decompress`** — secondary commands; the state
  model already supports them.

See [`docs/design.md`](./docs/design.md) for the full architecture, the
OpenCode→omp API mapping, and the message-identity design (omp messages carry no
stable id, so identity is derived from `tool_use.id` + content signatures).

## License

AGPL-3.0-or-later, matching upstream DCP.
