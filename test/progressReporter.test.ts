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

describe('progress reporter failures', () => {
  it('a failing progress write does not fail or replace the result of the call', async () => {
    let writes = 0;
    const reporter = createProgressReporter({
      write: async () => {
        writes += 1;
        throw new Error('disco cheio');
      },
      stream: { write: () => undefined, isTTY: false },
      env: {},
    });
    await expect(
      reporter.trackCall(info, async (onEvent) => {
        onEvent({ type: 'tool', name: 'Read', arg: 'x' });
        return 'texto';
      }),
    ).resolves.toBe('texto');
    expect(writes).toBe(3);
  });

  it('a failing progress write does not mask the error of the runner', async () => {
    const reporter = createProgressReporter({
      write: async () => {
        throw new Error('disco cheio');
      },
      stream: { write: () => undefined, isTTY: false },
      env: {},
    });
    await expect(
      reporter.trackCall(info, async () => {
        throw new RunnerError('falhou de verdade');
      }),
    ).rejects.toThrow('falhou de verdade');
  });
});

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

  it('prints no footer when stderr is not a TTY', async () => {
    const { reporter, out } = await setup();

    await reporter.trackCall(
      { ...info, limitMs: 30 * 60 * 1000 },
      async (onEvent) => {
        onEvent({ type: 'inactivity', idleMs: 120_000 });
        await reporter.report({
          type: 'step',
          id: 'build',
          label: 'npm test',
          phase: 'start',
        });
        reporter.pauseFooter();
        reporter.resumeFooter();
        return 'done';
      },
    );

    const text = out.join('');
    expect(text).not.toContain('\r');
    expect(text).not.toContain('\x1b');
    expect(text).not.toContain('/30m');
  });

  it('drops the inactivity notice from the footer once the agent is active again', async () => {
    const out: string[] = [];
    const reporter = createProgressReporter({
      write: async () => undefined,
      stream: { write: (t) => out.push(t), isTTY: true, columns: 120 },
      env: {},
      now: () => 0,
    });

    await reporter.trackCall(info, async (onEvent) => {
      onEvent({ type: 'inactivity', idleMs: 120_000 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const warned = out.join('');
      expect(warned).toContain('sem atividade há 2m');
      out.length = 0;
      onEvent({ type: 'activity' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      reporter.pauseFooter();
      reporter.resumeFooter();
      return 'done';
    });

    const after = out.join('');
    expect(after).toContain('voltou a ter atividade');
    expect(after).not.toContain('sem atividade há');
  });

  it('draws and erases the footer in place on a TTY', async () => {
    const out: string[] = [];
    const reporter = createProgressReporter({
      write: async () => undefined,
      stream: { write: (t) => out.push(t), isTTY: true, columns: 80 },
      env: {},
      now: () => 0,
    });

    await reporter.trackCall(
      { ...info, label: 'candidato 1', limitMs: 30 * 60 * 1000 },
      async () => {
        // Let the start line and the footer be drawn before the "question".
        await new Promise((resolve) => setTimeout(resolve, 0));
        reporter.pauseFooter();
        out.push('<ask>');
        reporter.resumeFooter();
        return 'done';
      },
    );

    const text = out.join('');
    expect(text).toContain('candidato 1 0s/30m');
    expect(text.indexOf('\r\x1b[2K<ask>')).toBeGreaterThan(-1);
  });

  it('draws the footer without color codes when NO_COLOR is set on a TTY', async () => {
    const out: string[] = [];
    const reporter = createProgressReporter({
      write: async () => undefined,
      stream: { write: (t) => out.push(t), isTTY: true, columns: 80 },
      env: { NO_COLOR: '1' },
      now: () => 0,
    });

    await reporter.trackCall(
      { ...info, label: 'candidato 1', limitMs: 30 * 60 * 1000 },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return 'done';
      },
    );

    const text = out.join('');
    expect(text).toContain('\r\x1b[2Kcandidato 1 0s/30m');
    // The only escape sequence allowed is the erase-line one.
    expect(text.replace(/\x1b\[2K/g, '')).not.toContain('\x1b'); // eslint-disable-line no-control-regex
  });

  it('never lets the footer, with its ellipsis, pass the terminal width', async () => {
    const columns = 40;
    const out: string[] = [];
    const reporter = createProgressReporter({
      write: async () => undefined,
      stream: { write: (t) => out.push(t), isTTY: true, columns },
      env: {},
      now: () => 0,
    });
    const calls = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'].map((label, i) =>
      reporter.trackCall({ ...info, id: `c${i}`, label }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'done';
      }),
    );
    await Promise.all(calls);

    const footers = out
      .filter((t) => t.startsWith('\r\x1b[2K') && t.length > 4)
      .map((t) => t.replace(/\x1b\[\d*m/g, '').replace('\r\x1b[2K', '')); // eslint-disable-line no-control-regex
    expect(footers.length).toBeGreaterThan(0);
    expect(footers.some((f) => f.endsWith('…'))).toBe(true);
    for (const footer of footers) {
      expect(footer.length).toBeLessThan(columns);
    }
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
