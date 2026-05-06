import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import {
  CursorAcpProvider,
  isCursorAgentAvailable,
  isCursorLoggedIn,
  resetCursorLoginCache,
  resetAgentBin,
  parseCursorModelList,
  listCursorModels,
  resetCursorModelCache,
  ensureBashShim,
} from '../cursor-acp.js';
import type { LLMConfig } from '../types.js';

const spawn = vi.fn();
const execSync = vi.fn();
const execFileSync = vi.fn();
const accessSync = vi.fn();
const existsSync = vi.fn();
const mkdirSync = vi.fn();
const writeFileSync = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawn(...args),
  execSync: (...args: unknown[]) => execSync(...args),
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    default: {
      ...actual,
      accessSync: (...args: unknown[]) => accessSync(...args),
      existsSync: (...args: unknown[]) => existsSync(...args),
      mkdirSync: (...args: unknown[]) => mkdirSync(...args),
      writeFileSync: (...args: unknown[]) => writeFileSync(...args),
    },
  };
});

function mockPrintAgent(output: string, exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  child.kill = vi.fn();
  child.killed = false;

  spawn.mockReturnValue(child);

  // Emit output and close async
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from(output));
    child.emit('close', exitCode);
  }, 0);

  return child;
}

describe('CursorAcpProvider', () => {
  const originalEnv = process.env;

  function assertSpawnArgs(expectedArgs: any[]) {
    if (process.platform === 'win32') {
      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ shell: true }),
      );
      const cmdStr = spawn.mock.calls[0][0] as string;
      expect(cmdStr).toContain('agent');
      for (const arg of expectedArgs) {
        if (typeof arg === 'string') {
          expect(cmdStr).toContain(arg);
        }
      }
    } else {
      expect(spawn).toHaveBeenCalledWith('agent', expectedArgs, expect.any(Object));
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetAgentBin();
    accessSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    process.env = { ...originalEnv };
    delete process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_AUTH_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('call() returns text output from --print mode', async () => {
    mockPrintAgent('{"languages":["TypeScript"]}');

    const provider = new CursorAcpProvider({ provider: 'cursor', model: 'sonnet-4.6' });
    const result = await provider.call({ system: 'Return JSON.', prompt: 'Detect stack.' });

    expect(result).toBe('{"languages":["TypeScript"]}');
    assertSpawnArgs([
      '--print',
      '--trust',
      '--workspace',
      expect.any(String),
      '--model',
      'sonnet-4.6',
    ]);
  });

  it('includes --api-key when CURSOR_API_KEY is set', async () => {
    process.env.CURSOR_API_KEY = 'test-key';
    mockPrintAgent('ok');

    const provider = new CursorAcpProvider({ provider: 'cursor', model: 'sonnet-4.6' });
    await provider.call({ system: 'S', prompt: 'P' });

    assertSpawnArgs([
      '--print',
      '--trust',
      '--workspace',
      expect.any(String),
      '--model',
      'sonnet-4.6',
      '--api-key',
      'test-key',
    ]);
  });

  it('includes --model auto when model is "auto"', async () => {
    mockPrintAgent('ok');

    const provider = new CursorAcpProvider({ provider: 'cursor', model: 'auto' });
    await provider.call({ system: 'S', prompt: 'P' });

    assertSpawnArgs(['--print', '--trust', '--workspace', expect.any(String), '--model', 'auto']);
  });

  it('does not include --model when model is "default"', async () => {
    mockPrintAgent('ok');

    const provider = new CursorAcpProvider({ provider: 'cursor', model: 'default' });
    await provider.call({ system: 'S', prompt: 'P' });

    assertSpawnArgs(['--print', '--trust', '--workspace', expect.any(String)]);
  });

  it('stream() emits text from stream-json events', async () => {
    const events =
      [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ text: 'Hello' }] },
          timestamp_ms: 1,
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ text: ' World' }] },
          timestamp_ms: 2,
        }),
        JSON.stringify({ type: 'result', duration_ms: 100 }),
      ].join('\n') + '\n';

    mockPrintAgent(events);

    const chunks: string[] = [];
    let ended = false;
    const provider = new CursorAcpProvider({ provider: 'cursor', model: 'sonnet-4.6' });

    await provider.stream(
      { system: 'S', prompt: 'P' },
      {
        onText: (text) => chunks.push(text),
        onEnd: () => {
          ended = true;
        },
        onError: () => {},
      },
    );

    expect(chunks).toEqual(['Hello', ' World']);
    expect(ended).toBe(true);
    assertSpawnArgs([
      '--print',
      '--trust',
      '--workspace',
      expect.any(String),
      '--model',
      'sonnet-4.6',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
    ]);
  });

  it('uses CURSOR_API_KEY from env when set', () => {
    process.env.CURSOR_API_KEY = 'test-key';
    const config: LLMConfig = { provider: 'cursor', model: 'default' };
    const provider = new CursorAcpProvider(config);
    expect(provider).toBeDefined();
  });
});

describe('isCursorAgentAvailable', () => {
  beforeEach(() => {
    resetAgentBin();
    execSync.mockReset();
    accessSync.mockReset();
    accessSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  it('returns true when agent binary is on PATH', () => {
    execSync.mockReturnValue(undefined);
    expect(isCursorAgentAvailable()).toBe(true);
    const expectedCmd = process.platform === 'win32' ? 'where agent' : 'which agent';
    expect(execSync).toHaveBeenCalledWith(expectedCmd, { stdio: 'ignore' });
  });

  it('returns true when found via well-known path', () => {
    execSync.mockImplementation(() => {
      throw new Error('not found');
    });
    accessSync.mockImplementation(() => undefined);
    expect(isCursorAgentAvailable()).toBe(true);
  });

  it('returns false when agent binary is not found anywhere', () => {
    execSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(isCursorAgentAvailable()).toBe(false);
  });
});

describe('isCursorLoggedIn', () => {
  beforeEach(() => {
    resetAgentBin();
    resetCursorLoginCache();
    execSync.mockReset();
    execFileSync.mockReset();
    accessSync.mockReset();
    accessSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  it('returns true when status output does not contain "not logged in"', () => {
    if (process.platform === 'win32') {
      execSync.mockReturnValue(Buffer.from('Logged in as user@example.com'));
    } else {
      execFileSync.mockReturnValue(Buffer.from('Logged in as user@example.com'));
    }
    expect(isCursorLoggedIn()).toBe(true);
  });

  it('returns false when status output contains "not logged in"', () => {
    if (process.platform === 'win32') {
      execSync.mockReturnValue(Buffer.from('not logged in'));
    } else {
      execFileSync.mockReturnValue(Buffer.from('not logged in'));
    }
    expect(isCursorLoggedIn()).toBe(false);
  });

  it('returns false when the command throws', () => {
    execSync.mockImplementation(() => {
      throw new Error('command failed');
    });
    execFileSync.mockImplementation(() => {
      throw new Error('command failed');
    });
    expect(isCursorLoggedIn()).toBe(false);
  });

  it('caches the result across calls', () => {
    if (process.platform === 'win32') {
      execSync.mockReturnValue(Buffer.from('Logged in'));
    } else {
      execFileSync.mockReturnValue(Buffer.from('Logged in'));
    }
    expect(isCursorLoggedIn()).toBe(true);
    execSync.mockReset();
    execFileSync.mockReset();
    expect(isCursorLoggedIn()).toBe(true);
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe('parseCursorModelList', () => {
  it('parses model list from error output', () => {
    const output =
      'Cannot use this model: __caliber_probe__. Available models: auto, composer-2, claude-4.6-sonnet-medium';
    expect(parseCursorModelList(output)).toEqual([
      'auto',
      'composer-2',
      'claude-4.6-sonnet-medium',
    ]);
  });

  it('returns empty array when no model list present', () => {
    expect(parseCursorModelList('some random error')).toEqual([]);
  });

  it('handles single model', () => {
    expect(parseCursorModelList('Available models: auto')).toEqual(['auto']);
  });
});

describe('listCursorModels', () => {
  beforeEach(() => {
    resetAgentBin();
    resetCursorModelCache();
    execSync.mockReset();
    execFileSync.mockReset();
    accessSync.mockReset();
    accessSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  it('parses models from error thrown by execFileSync', async () => {
    const errOutput =
      'Cannot use this model: __caliber_probe__. Available models: auto, composer-2-fast';
    if (process.platform === 'win32') {
      execSync.mockImplementation(() => {
        throw Object.assign(new Error(errOutput), {
          stdout: Buffer.from(''),
          stderr: Buffer.from(errOutput),
        });
      });
    } else {
      execFileSync.mockImplementation(() => {
        throw Object.assign(new Error(errOutput), {
          stdout: Buffer.from(''),
          stderr: Buffer.from(errOutput),
        });
      });
    }
    const models = await listCursorModels();
    expect(models).toEqual(['auto', 'composer-2-fast']);
  });

  it('caches results across calls', async () => {
    const errOutput = 'Available models: auto';
    if (process.platform === 'win32') {
      execSync.mockImplementation(() => {
        throw Object.assign(new Error(errOutput), {
          stdout: Buffer.from(''),
          stderr: Buffer.from(errOutput),
        });
      });
    } else {
      execFileSync.mockImplementation(() => {
        throw Object.assign(new Error(errOutput), {
          stdout: Buffer.from(''),
          stderr: Buffer.from(errOutput),
        });
      });
    }
    await listCursorModels();
    execSync.mockReset();
    execFileSync.mockReset();
    const models = await listCursorModels();
    expect(models).toEqual(['auto']);
  });

  it('returns empty array on unexpected error', async () => {
    execSync.mockImplementation(() => {
      throw new Error('timeout');
    });
    execFileSync.mockImplementation(() => {
      throw new Error('timeout');
    });
    const models = await listCursorModels();
    expect(models).toEqual([]);
  });
});

describe('ensureBashShim', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    resetAgentBin();
    execSync.mockReset();
    accessSync.mockReset();
    existsSync.mockReset();
    mkdirSync.mockReset();
    writeFileSync.mockReset();
    accessSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('returns null on non-Windows platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(ensureBashShim()).toBeNull();
  });

  it('returns null when agent binary cannot be resolved', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    execSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(ensureBashShim()).toBeNull();
  });

  it.skipIf(process.platform !== 'win32')(
    'creates shim when agent is resolved but not on bash PATH',
    () => {
      accessSync.mockImplementation(() => undefined);
      existsSync.mockReturnValue(true);
      let callCount = 0;
      execSync.mockImplementation(() => {
        callCount++;
        if (callCount <= 1)
          return Buffer.from('C:\\Users\\test\\AppData\\Local\\cursor-agent\\agent.cmd\n');
        throw new Error('not found');
      });
      const result = ensureBashShim();
      expect(result).not.toBeNull();
      expect(result!.created).toBe(true);
      expect(writeFileSync).toHaveBeenCalled();
    },
  );
});
