import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CopilotCliError,
  buildInvocation,
  createCopilotCliRunner,
} from '../../src/runners/copilot-cli.js';

const read = { prompt: 'p', files: [], canEdit: false };
const edit = { prompt: 'p', files: [], canEdit: true };
const opts = { cwd: '/tmp/x', allowedCommands: ['npm test', 'npx prettier'] };

/** Pairs of `--flag value`, so a test can look at them without caring about the order. */
function pairs(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => (a === flag ? [args[i + 1] ?? ''] : []));
}

describe('buildInvocation', () => {
  it('read-only denies write and shell, and never allows anything', () => {
    const { args } = buildInvocation(read, opts, 'p');
    expect(pairs(args, '--deny-tool').sort()).toEqual(['shell', 'write']);
    expect(args).not.toContain('--allow-tool');
  });

  it('editing allows write, only the listed commands, and denies git push, rm, curl and wget by prefix', () => {
    const { args } = buildInvocation(edit, opts, 'p');
    expect(pairs(args, '--allow-tool')).toEqual([
      'write',
      'shell(npm test)',
      'shell(npx prettier)',
    ]);
    expect(pairs(args, '--deny-tool')).toEqual([
      'shell(git push:*)',
      'shell(rm:*)',
      'shell(curl:*)',
      'shell(wget:*)',
    ]);
  });

  it('never allows a command that is on the always-denied list, even if the config lists it', () => {
    const { args } = buildInvocation(
      edit,
      {
        ...opts,
        allowedCommands: [
          'npm test',
          'rm -rf build',
          'git push origin x',
          'curl https://x',
        ],
      },
      'p',
    );
    expect(pairs(args, '--allow-tool')).toEqual(['write', 'shell(npm test)']);
  });

  it('never uses --allow-all, --allow-all-tools or --yolo, and confines the temp dir', () => {
    for (const req of [read, edit]) {
      const { args } = buildInvocation(req, opts, 'p');
      for (const flag of ['--allow-all', '--allow-all-tools', '--yolo'])
        expect(args).not.toContain(flag);
      expect(args).toContain('--disallow-temp-dir');
      expect(args).toContain('--no-ask-user');
      expect(args).toContain('--no-custom-instructions');
    }
  });

  it('passes the model and the usage file', () => {
    const { args } = buildInvocation(
      read,
      { ...opts, model: 'm1', usageFile: '/tmp/u.json' },
      'p',
    );
    expect(pairs(args, '--model')).toEqual(['m1']);
    expect(pairs(args, '--usage-output-file')).toEqual(['/tmp/u.json']);
  });
});

describe('createCopilotCliRunner', () => {
  function fakeChild(
    stdoutText: string,
    code = 0,
    stderrText = '',
  ): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr });
    setImmediate(() => {
      stdout.end(stdoutText);
      stderr.end(stderrText);
      setImmediate(() => child.emit('close', code));
    });
    return child;
  }

  it('returns the text copilot printed', async () => {
    const seen: string[][] = [];
    const runner = createCopilotCliRunner({
      cwd: '/repo',
      spawnFn: (_cmd, args) => {
        seen.push(args);
        return fakeChild('resposta\n');
      },
    });
    expect(await runner(read)).toBe('resposta');
    expect(seen[0]?.slice(0, 2)).toEqual(['-p', 'p']);
  });

  it('rejects on a non-zero exit and on empty output', async () => {
    await expect(
      createCopilotCliRunner({
        cwd: '/r',
        spawnFn: () => fakeChild('', 2, 'boom'),
      })(read),
    ).rejects.toThrow(/código 2: boom/);
    await expect(
      createCopilotCliRunner({ cwd: '/r', spawnFn: () => fakeChild('  ') })(
        read,
      ),
    ).rejects.toBeInstanceOf(CopilotCliError);
  });

  it('puts a very long prompt in a file inside the working directory instead of the argument', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-copilot-'));
    let received: string[] = [];
    const runner = createCopilotCliRunner({
      cwd,
      spawnFn: (_cmd, args) => {
        received = args;
        return fakeChild('ok');
      },
    });
    const big = 'x'.repeat(150_000);
    await runner({ ...read, prompt: big });
    expect(received[1]).toContain('Read the file');
    expect(received[1]?.length).toBeLessThan(500);
    const dir = join(cwd, '.workflow', 'prompts');
    const [file] = await readdir(dir);
    expect(file).toBeDefined();
    expect(await readFile(join(dir, file ?? ''), 'utf-8')).toContain(big);
  });
});
