import { describe, expect, it } from 'vitest';
import { createProgressReporter } from '../src/progressReporter.js';
import type { Runner } from '../src/runner.js';
import {
  SubagentEscalation,
  assertAllOk,
  labelRunner,
  runSubagents,
} from '../src/subagents.js';

const spec = (id: string) => ({ id, prompt: `task:${id}` });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('runSubagents', () => {
  it('runs in parallel but never above max_parallel', async () => {
    let inFlight = 0;
    let peak = 0;
    const runner: Runner = async (req) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return req.prompt;
    };
    const results = await runSubagents(
      runner,
      ['a', 'b', 'c', 'd', 'e'].map(spec),
      { maxParallel: 2 },
    );
    expect(peak).toBe(2);
    expect(results.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('uses the full width when max_parallel is larger than the list', async () => {
    let peak = 0;
    let inFlight = 0;
    const runner: Runner = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return 'ok';
    };
    await runSubagents(runner, [spec('a'), spec('b')], { maxParallel: 10 });
    expect(peak).toBe(2);
  });

  it('is always read-only', async () => {
    const seen: boolean[] = [];
    const runner: Runner = async (req) => {
      seen.push(req.canEdit);
      return 'ok';
    };
    await runSubagents(runner, [spec('a'), spec('b')], { maxParallel: 3 });
    expect(seen).toEqual([false, false]);
  });

  it('a failing subagent does not take down the others', async () => {
    const runner: Runner = async (req) => {
      if (req.prompt.includes('task:bad')) throw new Error('quebrou');
      return `ok:${req.prompt}`;
    };
    const results = await runSubagents(
      runner,
      [spec('a'), spec('bad'), spec('c')],
      { maxParallel: 3 },
    );
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    const bad = results[1];
    expect(bad && !bad.ok && bad.attempts).toBe(3);
    expect(bad && !bad.ok && bad.error).toBe('quebrou');
  });

  it('asks again after a malformed output and succeeds on the retry', async () => {
    let calls = 0;
    const runner: Runner = async (req) => {
      calls++;
      return calls === 1
        ? 'lixo'
        : `bom (${req.prompt.includes('inválida') ? 'com aviso' : 'sem aviso'})`;
    };
    const validate = (t: string) => {
      if (!t.startsWith('bom')) throw new Error('formato errado');
    };
    const [result] = await runSubagents(runner, [{ ...spec('a'), validate }], {
      maxParallel: 1,
    });
    expect(result).toMatchObject({
      ok: true,
      attempts: 2,
      text: 'bom (com aviso)',
    });
  });

  it('gives up after three failures in a row and calls the runner exactly three times', async () => {
    let calls = 0;
    const runner: Runner = async () => {
      calls++;
      return 'sempre lixo';
    };
    const validate = () => {
      throw new Error('malformado');
    };
    const [result] = await runSubagents(runner, [{ ...spec('a'), validate }], {
      maxParallel: 1,
    });
    expect(result).toMatchObject({
      ok: false,
      attempts: 3,
      error: 'malformado',
    });
    expect(calls).toBe(3);
  });
});

describe('assertAllOk', () => {
  it('returns the results when all are fine', async () => {
    const results = await runSubagents(async () => 'ok', [spec('a')], {
      maxParallel: 1,
    });
    expect(assertAllOk(results)).toHaveLength(1);
  });

  it('escalates with the failed ids and keeps what the others returned', async () => {
    const runner: Runner = async (req) => {
      if (req.prompt.includes('bad')) throw new Error('x');
      return 'resposta';
    };
    const results = await runSubagents(runner, [spec('a'), spec('bad')], {
      maxParallel: 2,
    });
    try {
      assertAllOk(results);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SubagentEscalation);
      const escalation = error as SubagentEscalation;
      expect(escalation.failed.map((f) => f.id)).toEqual(['bad']);
      expect(escalation.completed.map((c) => c.text)).toEqual(['resposta']);
    }
  });
});

describe('runSubagents labels', () => {
  const makeReporter = (out: string[]) =>
    createProgressReporter({
      write: async () => undefined,
      stream: { write: (text) => out.push(text), isTTY: false },
      env: {},
    });

  it('gives each parallel subagent lines that carry its own label', async () => {
    const out: string[] = [];
    const runner: Runner = async (req) => {
      const who = req.prompt.replace('task:', '');
      await tick();
      req.onEvent?.({ type: 'tool', name: 'Read', arg: `src/${who}.ts` });
      await tick();
      return who;
    };
    const results = await runSubagents(runner, [spec('a'), spec('b')], {
      maxParallel: 2,
      reporter: makeReporter(out),
      origin: 'recon',
      via: { runner: 'claude-cli', model: 'sonnet' },
    });
    expect(results.every((r) => r.ok)).toBe(true);
    const lines = out.join('').split('\n');
    for (const id of ['a', 'b']) {
      const label = `[recon · ${id} · claude-cli/sonnet]`;
      const mine = lines.filter((l) => l.startsWith(label));
      expect(mine.some((l) => l.includes(`Read src/${id}.ts`))).toBe(true);
      expect(mine.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('shows the CLI default when there is no model', async () => {
    const out: string[] = [];
    const runner: Runner = async (req) => {
      req.onEvent?.({ type: 'tool', name: 'Read', arg: 'x.ts' });
      return 'ok';
    };
    await runSubagents(runner, [spec('a')], {
      maxParallel: 1,
      reporter: makeReporter(out),
      origin: 'recon',
      via: { runner: 'claude-cli' },
    });
    expect(out.join('')).toContain('[recon · a · claude-cli/padrão do CLI]');
  });

  it('leaves the runner alone without a reporter', () => {
    const runner: Runner = async () => 'x';
    expect(labelRunner(runner, undefined, 'x')).toBe(runner);
  });
});
