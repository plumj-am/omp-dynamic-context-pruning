/**
 * Glob-based protection matching for tools and file paths.
 * Near-verbatim port of DCP's `lib/protected-patterns.ts` — pure logic, no
 * omp-specific concerns. Used by the strategies and compress to keep protected
 * tools / file operations out of pruning.
 */

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function escapeRegExpChar(ch: string): string {
  return /[\\.^$+{}()|[\]]/.test(ch) ? `\\${ch}` : ch;
}

export function matchesGlob(inputPath: string, pattern: string): boolean {
  if (!pattern) return false;
  const input = normalizePath(inputPath);
  const pat = normalizePath(pattern);

  let regex = "^";
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === "*") {
      const next = pat[i + 1];
      if (next === "*") {
        const after = pat[i + 2];
        if (after === "/") {
          regex += "(?:.*/)?";
          i += 2;
          continue;
        }
        regex += ".*";
        i += 1;
        continue;
      }
      regex += "[^/]*";
      continue;
    }
    if (ch === "?") {
      regex += "[^/]";
      continue;
    }
    if (ch === "/") {
      regex += "/";
      continue;
    }
    regex += escapeRegExpChar(ch);
  }
  regex += "$";
  return new RegExp(regex).test(input);
}

/**
 * Extract file paths from a tool call's parameters. Handles the common
 * `filePath` parameter plus omp-specific edit/patch shapes.
 */
export function getFilePathsFromParameters(tool: string, parameters: unknown): string[] {
  if (typeof parameters !== "object" || parameters === null) return [];
  const params = parameters as Record<string, unknown>;
  const paths: string[] = [];

  // apply_patch / edit patch text with embedded file headers
  if (typeof params.patchText === "string") {
    const pathRegex = /\*\*\* (?:Add|Delete|Update) File: ([^\n\r]+)/g;
    let match: RegExpExecArray | null;
    while ((match = pathRegex.exec(params.patchText)) !== null) {
      paths.push(match[1].trim());
    }
  }

  // multiedit: top-level filePath + nested edits array
  if (Array.isArray(params.edits)) {
    for (const edit of params.edits) {
      if (edit && typeof edit === "object" && typeof (edit as { filePath?: unknown }).filePath === "string") {
        paths.push((edit as { filePath: string }).filePath);
      }
    }
  }

  // common case: read/write/edit/etc.
  if (typeof params.filePath === "string") paths.push(params.filePath);
  if (typeof params.path === "string") paths.push(params.path);

  return [...new Set(paths)].filter((p) => p.length > 0);
}

export function isFilePathProtected(filePaths: string[], patterns: string[]): boolean {
  if (!filePaths || filePaths.length === 0) return false;
  if (!patterns || patterns.length === 0) return false;
  return filePaths.some((path) => patterns.some((pattern) => matchesGlob(path, pattern)));
}

const GLOB_CHARS = /[*?]/;

export function isToolNameProtected(toolName: string, patterns: string[]): boolean {
  if (!toolName || !patterns || patterns.length === 0) return false;
  const exact = new Set<string>();
  const globs: string[] = [];
  for (const pattern of patterns) {
    if (GLOB_CHARS.test(pattern)) globs.push(pattern);
    else exact.add(pattern);
  }
  if (exact.has(toolName)) return true;
  return globs.some((pattern) => matchesGlob(toolName, pattern));
}
