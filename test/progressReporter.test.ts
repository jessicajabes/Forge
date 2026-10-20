import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProgressWriter, PROGRESS_FILE } from '../src/progress.js';
import { createProgressReporter } from '../src/progressReporter.js';
import { RunnerError, RunnerTimeoutError } from '../src/runner.js';

const info = {
  id: 'c1',
  label: 'dev · claude-cli',
  runner: 'claude-cli',
  model: null,
  canEdit: false,
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true })));
});

async function setup(quiet = false) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-progress-'));
  dirs.push(dir);
  const out: string[] = [];
  let tick = 0;
  const reporter = createProgressReporter({
    write: createProgressWriter(dir),
    stream: { write: (text) => out.push(text), isTTY: false },
    quiet,
    env: {},
    now: () => (tick += 1000),
  });
  const lines = async () =>
    (await readFile(join(dir, PROGRESS_FILE), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { reporter, out, lines };
}

describe('progress reporter', () => {
  it('prints the end lines of an error and a timeout and writes progress.jsonl', async () => {
    const { reporter, out, lines } = await setup();
    const stderr = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n');

    await expect(
      reporter.trackCall(info, async (onEvent) => {
        onEvent({ type: 'tool', name: 'Read', arg: 'src/x.ts' });
        throw new RunnerError('failed', { stderr, exitCode: 2 });
      }),
    ).rejects.toThrow('failed');
    await expect(
      reporter.trackCall({ ...info, id: 'c2' }, async () => {
        throw new RunnerTimeoutError('slow', 30 * 60 * 1000, 'killed');
      }),
    ).rejects.toThrow('slow');

    expect(out.join('').split('\n')).toEqual([
      '[dev · claude-cli] claude-cli · modelo: padrão do CLI · só leitura',
      '[dev · claude-cli] Read src/x.ts',
      '[dev · claude-cli] erro em 1s: código de saída 2',
      '  [dev · claude-cli] l3',
      '  [dev · claude-cli] l4',
      '  [dev · claude-cli] l5',
      '  [dev · claude-cli] l6',
      '  [dev · claude-cli] l7',
      '[dev · claude-cli] claude-cli · modelo: padrão do CLI · só leitura',
      '[dev · claude-cli] erro em 1s: encerrado por timeout após 30m',
      '  [dev · claude-cli] killed',
      '',
    ]);

    const written = await lines();
    expect(written.map((l) => l.type)).toEqual([
      'call-start',
      'tool',
      'call-end',
      'call-start',
      'timeout',
      'call-end',
    ]);
    expect(written[2]).toMatchObject({ ok: false, stderr });
    expect(written[4]).toMatchObject({ id: 'c2', limitMs: 30 * 60 * 1000 });
    expect(written[5]).toMatchObject({
      ok: false,
      reason: 'encerrado por timeout após 30m',
    });
    expect(typeof written[0]?.at).toBe('string');
  });

  it('prints nothing with quiet but still writes progress.jsonl', async () => {
    const { reporter, out, lines } = await setup(true);

    await reporter.trackCall(info, async (onEvent) => {
      onEvent({ type: 'model', model: 'claude-sonnet-5-5' });
      return 'done';
    });

    expect(out).toEqual([]);
    expect((await lines()).map((l) => l.type)).toEqual([
      'call-start',
      'model',
      'call-end',
    ]);
  });
});
