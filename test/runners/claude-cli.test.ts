import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { RunnerTimeoutError } from '../../src/runner.js';
import {
  ClaudeCliError,
  buildInvocation,
  createClaudeCliRunner,
  parseStream,
  parseStreamEvents,
} from '../../src/runners/claude-cli.js';

const read = { prompt: 'p', files: [], canEdit: false };
const edit = { prompt: 'p', files: [], canEdit: true };
const opts = { cwd: '/tmp/x', allowedCommands: ['npm test', 'npx prettier'] };

function toolsOf(args: string[]): string[] {
  return (args[args.indexOf('--tools') + 1] ?? '').split(',');
}

describe('buildInvocation', () => {
  it('read-only never offers Edit, Write or Bash', () => {
    const { args } = buildInvocation(read, opts, {});
    expect(toolsOf(args)).toEqual(['Read', 'Grep', 'Glob']);
    expect(args.join(' ')).not.toMatch(/Edit|Write|Bash|acceptEdits/);
  });

  it('editing allows only the listed shell commands and never bypasses permissions', () => {
    const { args } = buildInvocation(edit, opts, {});
    expect(toolsOf(args)).toContain('Edit');
    expect(args).toContain('Bash(npm test:*)');
    expect(args).toContain('Bash(npx prettier:*)');
    expect(args).not.toContain('Bash');
    expect(args.join(' ')).not.toMatch(/bypassPermissions|dangerously/);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
  });

  it('an editing call has no turn limit unless editMaxTurns is set, and a read-only call has 20', () => {
    expect(buildInvocation(edit, opts, {}).args).not.toContain('--max-turns');
    const readArgs = buildInvocation(read, opts, {}).args;
    expect(readArgs[readArgs.indexOf('--max-turns') + 1]).toBe('20');
    const limited = buildInvocation(edit, { ...opts, editMaxTurns: 90 }, {});
    expect(limited.args[limited.args.indexOf('--max-turns') + 1]).toBe('90');
  });

  it('is isolated by default: project settings only, no MCP, no skills, no auto memory', () => {
    const { args, env } = buildInvocation(read, opts, {});
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1');
  });

  it('drops the isolation flags when isolated is false', () => {
    const { args, env } = buildInvocation(
      read,
      { ...opts, isolated: false },
      {},
    );
    expect(args).not.toContain('--setting-sources');
    expect(args).not.toContain('--strict-mcp-config');
    expect(env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBeUndefined();
  });

  it('passes the model and lists the files in the prompt', () => {
    const inv = buildInvocation(
      { ...read, files: ['a.ts'] },
      { ...opts, model: 'm1' },
      {},
    );
    expect(inv.args[inv.args.indexOf('--model') + 1]).toBe('m1');
    expect(inv.stdin).toContain('- a.ts');
    expect(inv.stdin.endsWith('p')).toBe(true);
  });
});

describe('parseStream', () => {
  const ok = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"texto final"}',
  ].join('\n');

  it('returns the text of the final result event', () => {
    expect(parseStream(ok)).toBe('texto final');
  });

  it('fails on an error result and on a missing result', () => {
    expect(() =>
      parseStream(
        '{"type":"result","subtype":"error_max_turns","is_error":true}',
      ),
    ).toThrow(ClaudeCliError);
    expect(() => parseStream('{"type":"system"}')).toThrow(/não devolveu/);
  });
});

describe('parseStreamEvents', () => {
  const assistant = (...content: object[]) =>
    JSON.stringify({ type: 'assistant', message: { content } });
  const use = (name: string, input: object) => ({
    type: 'tool_use',
    id: 't1',
    name,
    input,
  });

  it('reads Read, Grep and Bash tool_use events with their main argument', () => {
    expect(
      parseStreamEvents(assistant(use('Read', { file_path: 'src/x.ts' }))),
    ).toEqual([{ type: 'tool', name: 'Read', arg: 'src/x.ts' }]);
    expect(
      parseStreamEvents(
        assistant(use('Grep', { pattern: 'foo', path: 'src' })),
      ),
    ).toEqual([{ type: 'tool', name: 'Grep', arg: '"foo" src' }]);
    expect(
      parseStreamEvents(assistant(use('Bash', { command: 'npm test' }))),
    ).toEqual([{ type: 'tool', name: 'Bash', arg: 'npm test' }]);
  });

  it('gives an unknown tool with the name only', () => {
    expect(
      parseStreamEvents(assistant(use('WebFetch', { url: 'http://x' }))),
    ).toEqual([{ type: 'tool', name: 'WebFetch', arg: '' }]);
  });

  it('skips the text of the model and keeps several tools in order', () => {
    const events = parseStreamEvents(
      assistant(
        { type: 'text', text: 'vou ler' },
        use('Read', { file_path: 'a.ts' }),
        use('Glob', { pattern: '*.ts' }),
      ),
    );
    expect(events.map((e) => e.type === 'tool' && e.name)).toEqual([
      'Read',
      'Glob',
    ]);
    expect(JSON.stringify(events)).not.toContain('vou ler');
  });

  it('reads the model of system/init', () => {
    expect(
      parseStreamEvents(
        '{"type":"system","subtype":"init","model":"claude-sonnet-5-5"}',
      ),
    ).toEqual([{ type: 'model', model: 'claude-sonnet-5-5' }]);
  });

  it('ignores results, tool results, other system events and broken lines', () => {
    expect(parseStreamEvents('{"type":"system","subtype":"init"}')).toEqual([]);
    expect(parseStreamEvents('{"type":"system","subtype":"hook"}')).toEqual([]);
    expect(
      parseStreamEvents(
        '{"type":"user","message":{"content":[{"type":"tool_result","content":"segredo"}]}}',
      ),
    ).toEqual([]);
    expect(
      parseStreamEvents('{"type":"result","subtype":"success","result":"x"}'),
    ).toEqual([]);
    expect(parseStreamEvents('{broken')).toEqual([]);
    expect(parseStreamEvents('')).toEqual([]);
  });
});

describe('createClaudeCliRunner', () => {
  function fakeChild(output: string, code = 0, stderrText = ''): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    Object.assign(child, { stdout, stderr, stdin });
    stdin.on('finish', () => {
      stderr.end(stderrText);
      stdout.end(output);
      setImmediate(() => child.emit('close', code));
    });
    return child;
  }

  it('runs claude through spawnFn and returns the result', async () => {
    const seen: { cmd: string; cwd: string }[] = [];
    const runner = createClaudeCliRunner({
      cwd: '/repo',
      spawnFn: (cmd, _args, o) => {
        seen.push({ cmd, cwd: o.cwd });
        return fakeChild(
          '{"type":"result","subtype":"success","is_error":false,"result":"oi"}\n',
        );
      },
    });
    expect(await runner(read)).toBe('oi');
    expect(seen).toEqual([{ cmd: 'claude', cwd: '/repo' }]);
  });

  it('calls onEvent for the model and tools, even when a line is split across chunks', async () => {
    const lines = [
      '{"type":"system","subtype":"init","model":"m-real"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"a.ts"}}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"oi"}',
    ].join('\n');
    const runner = createClaudeCliRunner({
      cwd: '/repo',
      spawnFn: () => {
        const child = new EventEmitter() as ChildProcess;
        const stdout = new PassThrough();
        const stdin = new PassThrough();
        Object.assign(child, { stdout, stderr: new PassThrough(), stdin });
        stdin.on('finish', () => {
          stdout.write(lines.slice(0, 90));
          stdout.end(lines.slice(90));
          setImmediate(() => child.emit('close', 0));
        });
        return child;
      },
    });
    const events: unknown[] = [];
    expect(await runner({ ...read, onEvent: (e) => events.push(e) })).toBe(
      'oi',
    );
    expect(events).toEqual([
      { type: 'model', model: 'm-real' },
      { type: 'tool', name: 'Read', arg: 'a.ts' },
    ]);
  });

  it('an editing call has no timeout unless editTimeoutMs is set, and a read-only call stops at 30 minutes', async () => {
    vi.useFakeTimers();
    try {
      const hang = () => {
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          stdin: new PassThrough(),
          kill: () => true,
        });
        return child;
      };
      const runner = createClaudeCliRunner({ cwd: '/repo', spawnFn: hang });
      let editSettled = false;
      const settle = () => {
        editSettled = true;
      };
      runner(edit).then(settle, settle);
      const readResult = runner(read).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      const timedOut = await readResult;
      expect(timedOut).toBeInstanceOf(RunnerTimeoutError);
      expect((timedOut as RunnerTimeoutError).limitMs).toBe(30 * 60_000);
      expect(editSettled).toBe(false);

      const limited = createClaudeCliRunner({
        cwd: '/repo',
        editTimeoutMs: 60_000,
        spawnFn: hang,
      });
      const outcome = limited(edit).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(61_000);
      const edited = await outcome;
      expect(edited).toBeInstanceOf(RunnerTimeoutError);
      expect((edited as RunnerTimeoutError).limitMs).toBe(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects when the process fails', async () => {
    const runner = createClaudeCliRunner({
      cwd: '/repo',
      spawnFn: () => fakeChild('', 1),
    });
    await expect(runner(read)).rejects.toThrow(ClaudeCliError);
  });

  it('a failure carries the full stderr and the exit code', async () => {
    const long = Array.from({ length: 80 }, (_, i) => `linha ${i}`).join('\n');
    const runner = createClaudeCliRunner({
      cwd: '/repo',
      spawnFn: () => fakeChild('', 3, long),
    });
    const error = (await runner(read).catch(
      (e: unknown) => e,
    )) as ClaudeCliError;
    expect(error).toBeInstanceOf(ClaudeCliError);
    expect(error.stderr).toBe(long);
    expect(error.exitCode).toBe(3);
  });

  it('warns when ANTHROPIC_API_KEY would replace the login', () => {
    const previous = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'chave-de-teste';
    const messages: string[] = [];
    try {
      createClaudeCliRunner({ cwd: '/repo', notice: (m) => messages.push(m) });
    } finally {
      if (previous === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = previous;
    }
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('ANTHROPIC_API_KEY');
    expect(messages[0]).not.toContain('chave-de-teste');
  });
});
