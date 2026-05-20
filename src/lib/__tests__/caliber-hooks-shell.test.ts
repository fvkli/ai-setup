import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT = path.resolve(process.cwd(), '.claude/hooks/caliber-check-sync.sh');

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-hooks-test-'));
  // `git init -q` makes it a real repo so `git rev-parse --git-dir` succeeds.
  // The hook now early-exits when not in a git repo, so a bare `.git/hooks/`
  // skeleton is no longer enough — we need an actual repository.
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  return dir;
}

function runScript(
  cwd: string,
  env: Record<string, string> = {},
): { status: number; stdout: string } {
  const result = spawnSync('sh', [SCRIPT], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
  return { status: result.status ?? 1, stdout: (result.stdout ?? '') + (result.stderr ?? '') };
}

describe('caliber-check-sync.sh', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Clean up any flag files created during tests
    try {
      const files = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('caliber-nudge-'));
      for (const f of files) fs.unlinkSync(path.join(os.tmpdir(), f));
    } catch {
      // best-effort
    }
  });

  it('exits 0 silently when the project directory is not a git repo', () => {
    // Common case: a `.claude/` directory was generated in a non-git directory
    // (scratch dir, model archive, etc.). Caliber refresh won't run there
    // anyway, so the nudge is just noise — must not fire.
    // Set $CLAUDE_PROJECT_DIR explicitly: that's how Claude Code passes the
    // project root into hooks, and the script now anchors its git check on
    // it (post-2026-05-19 fix for the nested-git-in-non-git-project bug).
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-nogit-'));
    try {
      const { status, stdout } = runScript(nonGitDir, {
        CLAUDE_PROJECT_DIR: nonGitDir,
      });
      expect(status).toBe(0);
      expect(stdout).not.toContain('"decision":"block"');
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it('exits 0 immediately when CALIBER_SUBPROCESS=1 (spawned by caliber)', () => {
    // Caliber spawns LLM subprocesses with CALIBER_SUBPROCESS=1 via spawnClaude/etc.
    // The Stop hook must not block in that context or it will cancel SessionEnd hooks,
    // causing Claude CLI to exit with code 1 and breaking `caliber refresh`.
    const { status, stdout } = runScript(tmpDir, { CALIBER_SUBPROCESS: '1' });
    expect(status).toBe(0);
    expect(stdout).not.toContain('"decision":"block"');
  });

  it('exits 0 immediately when legacy CALIBER_SPAWNED=1 (transition compatibility)', () => {
    // Legacy env var is still written by spawn helpers for one release window so
    // stale .claude/hooks/*.sh files installed by older Caliber keep working.
    // The script honors both names; this test pins that contract.
    const { status, stdout } = runScript(tmpDir, { CALIBER_SPAWNED: '1' });
    expect(status).toBe(0);
    expect(stdout).not.toContain('"decision":"block"');
  });

  it('exits 0 when caliber is present in the pre-commit hook', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\ncaliber refresh\n',
    );
    const { status } = runScript(tmpDir);
    expect(status).toBe(0);
  });

  it('outputs block decision when caliber is not set up and flag is not set', () => {
    const { stdout } = runScript(tmpDir);
    expect(stdout).toContain('"decision":"block"');
  });

  it('exits 0 on second run (flag file prevents repeat prompt)', () => {
    // First run sets the flag
    runScript(tmpDir);
    // Second run should exit 0 silently
    const { status, stdout } = runScript(tmpDir);
    expect(status).toBe(0);
    expect(stdout).not.toContain('"decision":"block"');
  });

  it('exits 0 when $PWD is a nested git repo but $CLAUDE_PROJECT_DIR is non-git', () => {
    // Real-world scenario observed 2026-05-19: a backup_models/ scratch
    // directory contains its own .claude/ but is itself NOT a git repo;
    // however a Mythic-RDT/ subdirectory inside it IS a git repo. When
    // Claude Code starts in the subdir, $PWD points at the nested git
    // while $CLAUDE_PROJECT_DIR still points at the non-git owner of
    // the .claude/. Pre-fix, `git rev-parse --git-dir` from $PWD
    // wrongly succeeded against the nested .git and fired the nudge
    // for a project Caliber has no business managing.
    //
    // The post-fix script anchors the git check on $CLAUDE_PROJECT_DIR
    // (with a script-relative fallback for shell-test invocations).
    const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-owner-'));
    const nested = path.join(owner, 'nested');
    fs.mkdirSync(nested);
    spawnSync('git', ['init', '-q'], { cwd: nested });
    try {
      const result = spawnSync('sh', [SCRIPT], {
        cwd: nested, // $PWD = nested git repo
        env: { ...process.env, CLAUDE_PROJECT_DIR: owner }, // non-git project root
        encoding: 'utf-8',
      });
      const stdout = (result.stdout ?? '') + (result.stderr ?? '');
      expect(result.status).toBe(0);
      expect(stdout).not.toContain('"decision":"block"');
    } finally {
      fs.rmSync(owner, { recursive: true, force: true });
    }
  });

  it('honors $CLAUDE_PROJECT_DIR when set, even when $PWD is unrelated', () => {
    // Positive case: $CLAUDE_PROJECT_DIR points at a real git project
    // whose pre-commit lacks caliber → nudge should fire. Confirms
    // the new anchor reads the right directory's pre-commit, not
    // whatever pre-commit happens to live under $PWD.
    const otherPwd = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-other-pwd-'));
    try {
      const result = spawnSync('sh', [SCRIPT], {
        cwd: otherPwd,
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
        encoding: 'utf-8',
      });
      const stdout = (result.stdout ?? '') + (result.stderr ?? '');
      expect(result.status).toBe(0);
      expect(stdout).toContain('"decision":"block"');
    } finally {
      fs.rmSync(otherPwd, { recursive: true, force: true });
    }
  });
});
