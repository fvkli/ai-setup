import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { filterIgnoredWarnings } from '../large-file-filter.js';
import type { LargeFileWarning } from '../large-file-scan.js';

const MiB = 1_048_576;

function makeWarning(dir: string, relPath: string, sizeMB = 5): LargeFileWarning {
  return {
    filePath: path.join(dir, relPath),
    sizeBytes: sizeMB * MiB,
    sizeMB: sizeMB.toFixed(2),
  };
}

describe('filterIgnoredWarnings', () => {
  const DIR = '/project';

  // ── Empty input ──────────────────────────────────────────────────────────

  it('returns empty array without calling git when warnings are empty', () => {
    const execFileSync = vi.fn();
    const readFileSync = vi.fn();

    const result = filterIgnoredWarnings([], DIR, { execFileSync, readFileSync });

    expect(result).toHaveLength(0);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  // ── Git filter ───────────────────────────────────────────────────────────

  it('filters out gitignored files', () => {
    const warnings = [
      makeWarning(DIR, 'infra/.terraform/provider.bin'),
      makeWarning(DIR, 'src/data.csv'),
    ];

    const execFileSync = vi.fn().mockReturnValue('infra/.terraform/provider.bin\n');
    const readFileSync = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = filterIgnoredWarnings(warnings, DIR, { execFileSync, readFileSync });

    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe(path.join(DIR, 'src/data.csv'));
  });

  it('keeps all warnings when git check-ignore finds none ignored (exit code 1)', () => {
    const warnings = [makeWarning(DIR, 'data/dump.sqlite'), makeWarning(DIR, 'assets/video.mp4')];

    const execFileSync = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('exit code 1'), { status: 1 });
    });
    const readFileSync = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = filterIgnoredWarnings(warnings, DIR, { execFileSync, readFileSync });

    expect(result).toHaveLength(2);
  });

  it('keeps all warnings when not in a git repo', () => {
    const warnings = [makeWarning(DIR, 'big-file.bin')];

    const execFileSync = vi.fn().mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });
    const readFileSync = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = filterIgnoredWarnings(warnings, DIR, { execFileSync, readFileSync });

    expect(result).toHaveLength(1);
  });

  it('filters multiple gitignored files from a mixed set', () => {
    const warnings = [
      makeWarning(DIR, '.terraform/provider-aws'),
      makeWarning(DIR, 'src/app.ts'),
      makeWarning(DIR, 'build/output.wasm'),
      makeWarning(DIR, 'data/seed.sql'),
    ];

    const execFileSync = vi.fn().mockReturnValue('.terraform/provider-aws\nbuild/output.wasm\n');
    const readFileSync = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = filterIgnoredWarnings(warnings, DIR, { execFileSync, readFileSync });
    const paths = result.map((w) => path.basename(w.filePath));

    expect(paths).toEqual(['app.ts', 'seed.sql']);
  });

  // ── Caliberignore filter ─────────────────────────────────────────────────

  it('filters files matching .caliberignore patterns', () => {
    const warnings = [makeWarning(DIR, 'data/dump.sqlite'), makeWarning(DIR, 'src/index.ts')];

    const execFileSync = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('exit code 1'), { status: 1 });
    });
    const readFileSync = vi.fn().mockReturnValue('*.sqlite\n');

    const result = filterIgnoredWarnings(warnings, DIR, { execFileSync, readFileSync });

    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe(path.join(DIR, 'src/index.ts'));
  });

  it('supports glob patterns in .caliberignore', () => {
    const warnings = [
      makeWarning(DIR, 'infra/admin/.terraform/provider-aws'),
      makeWarning(DIR, 'infra/cloud/.terraform/provider-aws'),
      makeWarning(DIR, 'src/data.csv'),
    ];

    const execFileSync = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('exit code 1'), { status: 1 });
    });
    const readFileSync = vi.fn().mockReturnValue('infra/**/.terraform/**\n');

    const result = filterIgnoredWarnings(warnings, DIR, { execFileSync, readFileSync });

    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe(path.join(DIR, 'src/data.csv'));
  });

  it('skips comments and empty lines in .caliberignore', () => {
    const warnings = [makeWarning(DIR, 'data/dump.sqlite'), makeWarning(DIR, 'assets/video.mp4')];

    const execFileSync = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('exit code 1'), { status: 1 });
    });
    const readFileSync = vi
      .fn()
      .mockReturnValue('# Large data files\n\n*.sqlite\n\n# Videos\n*.mp4\n');

    const result = filterIgnoredWarnings(warnings, DIR, { execFileSync, readFileSync });

    expect(result).toHaveLength(0);
  });

  it('keeps all warnings when .caliberignore does not exist', () => {
    const warnings = [makeWarning(DIR, 'data/big.bin')];

    const execFileSync = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('exit code 1'), { status: 1 });
    });
    const readFileSync = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = filterIgnoredWarnings(warnings, DIR, { execFileSync, readFileSync });

    expect(result).toHaveLength(1);
  });

  // ── Combined filters ────────────────────────────────────────────────────

  it('filters via both gitignore and caliberignore', () => {
    const warnings = [
      makeWarning(DIR, '.terraform/provider'),
      makeWarning(DIR, 'data/dump.sqlite'),
      makeWarning(DIR, 'src/app.ts'),
    ];

    const execFileSync = vi.fn().mockReturnValue('.terraform/provider\n');
    const readFileSync = vi.fn().mockReturnValue('*.sqlite\n');

    const result = filterIgnoredWarnings(warnings, DIR, { execFileSync, readFileSync });

    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe(path.join(DIR, 'src/app.ts'));
  });

  it('handles file ignored by both filters without double-counting', () => {
    const warnings = [makeWarning(DIR, 'build/output.wasm')];

    const execFileSync = vi.fn().mockReturnValue('build/output.wasm\n');
    const readFileSync = vi.fn().mockReturnValue('build/**\n');

    const result = filterIgnoredWarnings(warnings, DIR, { execFileSync, readFileSync });

    expect(result).toHaveLength(0);
  });

  // ── Path handling ───────────────────────────────────────────────────────

  it('correctly converts absolute paths to relative for filtering', () => {
    const dir = '/home/user/project';
    const warnings = [makeWarning(dir, 'deep/nested/dir/big.bin')];

    const execFileSync = vi.fn().mockReturnValue('deep/nested/dir/big.bin\n');
    const readFileSync = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = filterIgnoredWarnings(warnings, dir, { execFileSync, readFileSync });

    expect(result).toHaveLength(0);
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['check-ignore', '--stdin'],
      expect.objectContaining({ input: 'deep/nested/dir/big.bin' }),
    );
  });

  it('passes correct cwd to git check-ignore', () => {
    const dir = '/my/project';
    const warnings = [makeWarning(dir, 'file.bin')];

    const execFileSync = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('exit code 1'), { status: 1 });
    });
    const readFileSync = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    filterIgnoredWarnings(warnings, dir, { execFileSync, readFileSync });

    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      expect.any(Array),
      expect.objectContaining({ cwd: dir }),
    );
  });
});
