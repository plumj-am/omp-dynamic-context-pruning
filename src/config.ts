/**
 * DCP config model, defaults, discovery, and validation.
 *
 * Ported from the OpenCode DCP plugin's `lib/config.ts`, with the config-file
 * discovery paths adapted to omp conventions:
 *   1. project: <cwd>/.omp/dcp.jsonc  (or dcp.json)
 *   2. user:    ~/.omp/agent/dcp.jsonc (or dcp.json)
 *
 * Project overrides user. Restart omp after editing.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type Permission = "ask" | "allow" | "deny";
export type CompressMode = "range" | "message";
export type NudgeForce = "strong" | "soft";
export type PruneNotification = "off" | "minimal" | "detailed";
export type PruneNotificationType = "chat" | "toast";

export interface DeduplicationConfig {
  enabled: boolean;
  protectedTools: string[];
}

export interface CompressConfig {
  mode: CompressMode;
  permission: Permission;
  showCompression: boolean;
  summaryBuffer: boolean;
  maxContextLimit: number | `${number}%`;
  minContextLimit: number | `${number}%`;
  modelMaxLimits?: Record<string, number | `${number}%`>;
  modelMinLimits?: Record<string, number | `${number}%`>;
  nudgeFrequency: number;
  iterationNudgeThreshold: number;
  nudgeForce: NudgeForce;
  protectedTools: string[];
  protectTags: boolean;
  protectUserMessages: boolean;
}

export interface CommandsConfig {
  enabled: boolean;
  protectedTools: string[];
}

export interface ManualModeConfig {
  enabled: boolean;
  automaticStrategies: boolean;
}

export interface PurgeErrorsConfig {
  enabled: boolean;
  turns: number;
  protectedTools: string[];
}

export interface TurnProtectionConfig {
  enabled: boolean;
  turns: number;
}

export interface ExperimentalConfig {
  allowSubAgents: boolean;
  customPrompts: boolean;
}

export interface StrategiesConfig {
  deduplication: DeduplicationConfig;
  purgeErrors: PurgeErrorsConfig;
}

export interface PluginConfig {
  enabled: boolean;
  debug: boolean;
  pruneNotification: PruneNotification;
  pruneNotificationType: PruneNotificationType;
  commands: CommandsConfig;
  manualMode: ManualModeConfig;
  turnProtection: TurnProtectionConfig;
  experimental: ExperimentalConfig;
  protectedFilePatterns: string[];
  compress: CompressConfig;
  strategies: StrategiesConfig;
}

/** Always protected from pruning. */
export const DEFAULT_PROTECTED_TOOLS = [
  "task",
  "skill",
  "todowrite",
  "todoread",
  "compress",
  "batch",
  "plan_enter",
  "plan_exit",
  "write",
  "edit",
];

/** Tools whose completed outputs are appended into compression summaries. */
export const COMPRESS_DEFAULT_PROTECTED_TOOLS = ["task", "skill", "todowrite", "todoread"];

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  debug: false,
  pruneNotification: "detailed",
  pruneNotificationType: "chat",
  commands: { enabled: true, protectedTools: [] },
  manualMode: { enabled: false, automaticStrategies: true },
  turnProtection: { enabled: false, turns: 4 },
  experimental: { allowSubAgents: false, customPrompts: false },
  protectedFilePatterns: [],
  compress: {
    mode: "range",
    permission: "allow",
    showCompression: false,
    summaryBuffer: true,
    maxContextLimit: 100000,
    minContextLimit: 50000,
    nudgeFrequency: 5,
    iterationNudgeThreshold: 15,
    nudgeForce: "soft",
    protectedTools: [...COMPRESS_DEFAULT_PROTECTED_TOOLS],
    protectTags: false,
    protectUserMessages: false,
  },
  strategies: {
    deduplication: { enabled: true, protectedTools: [] },
    purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
  },
};

// ---------------------------------------------------------------------------
// JSONC parsing (tolerant — strips // and /* */ comments)
// ---------------------------------------------------------------------------

function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let stringChar = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === stringChar) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function readJsonc(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf8");
    const cleaned = stripJsonc(raw).trim();
    if (cleaned.length === 0) return {};
    // trailing commas break JSON.parse; strip them.
    const noTrailing = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(noTrailing) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function discoverConfigPaths(cwd: string): string[] {
  const candidates: string[] = [];
  const userDir = homedir();
  // project first (higher priority — applied last so it wins)
  candidates.push(join(cwd, ".omp", "dcp.jsonc"));
  candidates.push(join(cwd, ".omp", "dcp.json"));
  candidates.push(join(userDir, ".omp", "agent", "dcp.jsonc"));
  candidates.push(join(userDir, ".omp", "agent", "dcp.json"));
  return candidates;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) {
    return (override === undefined ? base : (override as T));
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, val] of Object.entries(override)) {
    if (val === undefined) continue;
    const baseVal = (base as Record<string, unknown>)[key];
    if (isObject(baseVal) && isObject(val)) {
      out[key] = deepMerge(baseVal, val);
    } else {
      out[key] = val;
    }
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ConfigDiagnostic {
  key: string;
  message: string;
}

export function validateConfig(raw: Record<string, unknown>): ConfigDiagnostic[] {
  const diag: ConfigDiagnostic[] = [];
  const booleans = [
    "enabled",
    "debug",
    "commands.enabled",
    "manualMode.enabled",
    "manualMode.automaticStrategies",
    "turnProtection.enabled",
    "experimental.allowSubAgents",
    "experimental.customPrompts",
    "compress.showCompression",
    "compress.summaryBuffer",
    "compress.protectTags",
    "compress.protectUserMessages",
    "strategies.deduplication.enabled",
    "strategies.purgeErrors.enabled",
  ];
  const numbers = [
    "compress.maxContextLimit",
    "compress.minContextLimit",
    "compress.nudgeFrequency",
    "compress.iterationNudgeThreshold",
    "turnProtection.turns",
    "strategies.purgeErrors.turns",
  ];
  const stringArrays = [
    "protectedFilePatterns",
    "commands.protectedTools",
    "compress.protectedTools",
    "strategies.deduplication.protectedTools",
    "strategies.purgeErrors.protectedTools",
  ];
  const enums: Record<string, readonly string[]> = {
    "pruneNotification": ["off", "minimal", "detailed"],
    "pruneNotificationType": ["chat", "toast"],
    "compress.mode": ["range", "message"],
    "compress.permission": ["ask", "allow", "deny"],
    "compress.nudgeForce": ["strong", "soft"],
  };

  const get = (path: string): unknown => {
    let cur: unknown = raw;
    for (const seg of path.split(".")) {
      if (!isObject(cur)) return undefined;
      cur = cur[seg];
    }
    return cur;
  };

  for (const key of booleans) {
    const v = get(key);
    if (v !== undefined && typeof v !== "boolean")
      diag.push({ key, message: `expected boolean, got ${typeof v}` });
  }
  for (const key of numbers) {
    const v = get(key);
    if (v === undefined) continue;
    if (typeof v === "string" && /^\d+%$/.test(v)) continue; // percentage form allowed for limits
    if (typeof v !== "number" || !Number.isFinite(v))
      diag.push({ key, message: `expected number, got ${JSON.stringify(v)}` });
  }
  for (const key of stringArrays) {
    const v = get(key);
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string")))
      diag.push({ key, message: "expected string[]" });
  }
  for (const [key, allowed] of Object.entries(enums)) {
    const v = get(key);
    if (v !== undefined && !allowed.includes(String(v)))
      diag.push({ key, message: `expected one of ${allowed.join("|")}, got ${JSON.stringify(v)}` });
  }
  return diag;
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

export interface LoadResult {
  config: PluginConfig;
  diagnostics: ConfigDiagnostic[];
  loadedFrom: string | null;
}

export function loadConfig(cwd: string): LoadResult {
  let merged: PluginConfig = jsonClone(DEFAULT_CONFIG);
  let loadedFrom: string | null = null;
  let userRaw: Record<string, unknown> | null = null;
  let allDiag: ConfigDiagnostic[] = [];

  // Apply user-level first, then project (project wins via later merge).
  const paths = discoverConfigPaths(cwd).reverse(); // user first, project last
  for (const p of paths) {
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    const raw = readJsonc(p);
    if (raw === null) continue;
    if (!userRaw) userRaw = raw;
    merged = deepMerge(merged, raw);
    loadedFrom = p;
  }

  if (userRaw) allDiag = validateConfig(userRaw);

  return { config: merged, diagnostics: allDiag, loadedFrom };
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
