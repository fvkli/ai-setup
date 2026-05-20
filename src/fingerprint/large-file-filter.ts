import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { minimatch } from 'minimatch';
import type { LargeFileWarning } from './large-file-scan.js';

export interface FilterDeps {
  execFileSync?: typeof execFileSync;
  readFileSync?: typeof fs.readFileSync;
}

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

function getGitIgnoredPaths(
  dir: string,
  relativePaths: string[],
  exec: typeof execFileSync,
): Set<string> | null {
  if (relativePaths.length === 0) return new Set();
  try {
    const result = exec('git', ['check-ignore', '--stdin'], {
      cwd: dir,
      encoding: 'utf-8',
      input: relativePaths.join('\n'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new Set(
      (result as string)
        .split('\n')
        .map((l) => toForwardSlash(l.trim()))
        .filter(Boolean),
    );
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'status' in err &&
      (err as { status: number }).status === 1
    ) {
      return new Set<string>();
    }
    return null;
  }
}

function loadCaliberIgnorePatterns(dir: string, read: typeof fs.readFileSync): string[] {
  try {
    const content = read(path.join(dir, '.caliberignore'), 'utf-8') as string;
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

function matchesCaliberIgnore(relativePath: string, patterns: string[]): boolean {
  const normalized = toForwardSlash(relativePath);
  return patterns.some((pattern) =>
    minimatch(normalized, pattern, { dot: true, matchBase: !pattern.includes('/') }),
  );
}

export function filterIgnoredWarnings(
  warnings: LargeFileWarning[],
  dir: string,
  deps: FilterDeps = {},
): LargeFileWarning[] {
  if (warnings.length === 0) return warnings;

  const exec = deps.execFileSync ?? execFileSync;
  const read = deps.readFileSync ?? fs.readFileSync;

  const relativePaths = warnings.map((w) => toForwardSlash(path.relative(dir, w.filePath)));

  const gitIgnored = getGitIgnoredPaths(dir, relativePaths, exec);

  const caliberPatterns = loadCaliberIgnorePatterns(dir, read);

  return warnings.filter((_, i) => {
    const rel = relativePaths[i];
    if (gitIgnored && gitIgnored.has(rel)) return false;
    if (caliberPatterns.length > 0 && matchesCaliberIgnore(rel, caliberPatterns)) return false;
    return true;
  });
}
