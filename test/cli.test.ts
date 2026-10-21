import { execFileSync } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageError, main, parseFlags, type CliDeps } from '../src/cli.js';
import { DEFAULT_WORKFLOW_YML, type Config } from '../src/config.js';
import { git } from '../src/git.js';
import type { RunnerFactory } from '../src/runner.js';
import { findIncompleteRun } from '../src/state.js';
import { createFakeIO } from './fakeIO.js';
import { makeRepo } from './helpers.js';

const CONTEXT = `# Project: demo\n\n## Overview\n${'Um projeto de demonstração bem descrito. '.repeat(8)}\n`;
const SPEC = `# Spec: Tarefa

## Objetivo
Fazer a tarefa.

## Decisões
- Fazer simples (provisória)

## Fora do escopo
- nenhum

## Restrições
- nenhuma

## Pontos em aberto
- nenhum
`;
const TASKS = `# Tarefas

## T1: Fazer
- **Arquivos**: src/a.ts
- **O que fazer**: Fazer.
- **Critério de aceite**:
  - [ ] \`npm test\` passa
- **Depende de**: nenhuma
`;
const APPROVED = JSON.stringify({ verdict: 'approved' });
const REJECT = JSON.stringify({
  verdict: 'rejected',
  act_on: [{ title: 'Ainda aberto', description: 'd' }],
});

type Script = {
  dev?: (cwd: string, call: number) => Promise<string>;
  lead?: () => string;
};

/** One scripted model for the whole pipeline, told apart by the prompt. */
function scripted(script: Script = {}) {
  let devCalls = 0;
  const calls: string[] = [];
  const configs: Config[] = [];
  const makeRunner = (config: Config): RunnerFactory => {
    configs.push(config);
    return ({ cwd }) =>
      async (req) => {
        const p = req.prompt;
        if (p.includes('How is this project built'))
          return (calls.push('recon'), CONTEXT);
        if (p.includes('spec writer of the Forge'))
          return (calls.push('spec'), SPEC);
        if (p.includes('Reply with the contents of tasks.md'))
          return (calls.push('tasks'), TASKS);
        if (p.includes('adversarial code reviewer'))
          return (calls.push('reviewer'), '## Findings\n\nno findings');
        if (p.includes('# Review (lead)'))
          return (calls.push('lead'), script.lead ? script.lead() : APPROVED);
        if (p.includes('You are the **'))
          return (calls.push('lens'), 'No candidates.');
        if (req.canEdit && p.includes('Batch ')) {
          calls.push('dev');
          const n = ++devCalls;
          if (script.dev) return script.dev(cwd, n);
          await writeFile(join(cwd, `out-${n}.txt`), 'x');
          return `1. Corrigido: ok\nrelatório ${n}`;
        }
        throw new Error(`prompt inesperado: ${p.slice(0, 80)}`);
      };
  };
  return { makeRunner, calls, configs };
}

async function deps(
  answers: string[],
  s = scripted(),
  over: Partial<CliDeps> = {},
) {
  const cwd = await makeRepo();
  await writeFile(join(cwd, '.workflow.yml'), 'dev:\n  check_commands: []\n');
  const io = createFakeIO(answers);
  const d: CliDeps = {
    cwd,
    isTTY: true,
    io,
    makeRunner: s.makeRunner,
    stderr: { write: () => true },
    ...over,
  };
  return { d, cwd, io, s };
}

describe('parseFlags', () => {
  it('reads the task and every flag', () => {
    const f = parseFlags([
      'adicionar',
      'login',
      '--size',
      'trivial',
      '--review',
      'per_task',
      '--arena',
      '4',
      '--refresh-context',
    ]);
    expect(f).toMatchObject({
      task: 'adicionar login',
      size: 'trivial',
      review: 'per_task',
      arena: 4,
      refreshContext: true,
      noArena: false,
    });
    expect(parseFlags(['x', '--no-arena']).noArena).toBe(true);
  });

  it('reads --quiet, off by default', () => {
    expect(parseFlags(['x', '--quiet']).quiet).toBe(true);
    expect(parseFlags(['x']).quiet).toBe(false);
  });

  it('rejects bad values with a clear message', () => {
    expect(() => parseFlags(['x', '--size', 'enorme'])).toThrow(UsageError);
    expect(() => parseFlags(['x', '--review', 'sempre'])).toThrow(/--review/);
    expect(() => parseFlags(['x', '--arena', '0'])).toThrow(/--arena/);
    expect(() => parseFlags(['x', '--desconhecida'])).toThrow(UsageError);
  });
});

describe('forge-jj', () => {
  it('runs a trivial task end to end: spec, tasks, approval, Dev, review, commit and lessons', async () => {
    const { d, cwd, io, s } = await deps(['aprovar']);
    const code = await main(
      ['corrigir o typo', '--size', 'trivial', '--review', 'final'],
      d,
    );
    expect(code).toBe(0);
    expect(s.calls).toEqual([
      'recon',
      'spec',
      'tasks',
      'dev',
      'reviewer',
      'lead',
      'lens',
      'lens',
      'lens',
    ]);
    // no new branch: the commit goes on the current one, with its name in the subject
    expect(await git(cwd, ['branch', '--show-current'])).toBe('feature/x');
    expect(await git(cwd, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(await git(cwd, ['log', '-1', '--format=%s'])).toMatch(
      /^feature\/x - T1 - /,
    );
    expect(io.output()).toContain('Pronto.');
    expect(io.output()).toContain('Custo estimado do Dev (Dev simples)');
  });

  it('logs every model call of the run in calls.jsonl', async () => {
    const { d, cwd, s } = await deps(['aprovar']);
    await main(
      ['corrigir o typo', '--size', 'trivial', '--review', 'final'],
      d,
    );
    const { readdir } = await import('node:fs/promises');
    const [runId] = await readdir(join(cwd, '.workflow', 'runs'));
    const log = await readFile(
      join(cwd, '.workflow', 'runs', runId ?? '', 'calls.jsonl'),
      'utf-8',
    );
    expect(log.split('\n').filter((l) => l.length > 0)).toHaveLength(
      s.calls.length,
    );
  });

  it('writes progress.jsonl and the stage lines on stderr; --quiet keeps the file and silences stderr', async () => {
    const run = async (extra: string[]) => {
      const lines: string[] = [];
      const { d, cwd, io } = await deps(['aprovar'], scripted(), {
        stderr: { write: (text) => lines.push(text) },
      });
      await main(['x', '--size', 'trivial', '--review', 'final', ...extra], d);
      const { readdir } = await import('node:fs/promises');
      const [runId] = await readdir(join(cwd, '.workflow', 'runs'));
      const file = await readFile(
        join(cwd, '.workflow', 'runs', runId ?? '', 'progress.jsonl'),
        'utf-8',
      );
      const events = file
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { type: string; at: string });
      return { lines, events, out: io.output() };
    };

    const loud = await run([]);
    expect(loud.lines.join('')).toContain('etapa recon');
    // progress goes to stderr only; stdout keeps the questions and the results
    expect(loud.out).not.toContain('etapa recon');
    expect(loud.events.some((e) => e.type === 'stage')).toBe(true);

    const quiet = await run(['--quiet']);
    expect(quiet.lines).toEqual([]);
    expect(quiet.events.some((e) => e.type === 'stage')).toBe(true);
    expect(quiet.events.some((e) => e.type === 'call-start')).toBe(true);
    for (const e of quiet.events) {
      expect(Number.isNaN(Date.parse(e.at))).toBe(false);
    }
  });

  it('flags skip the questions; without flags Enter takes the defaults', async () => {
    const withFlags = await deps(['aprovar']);
    await main(['x', '--size', 'trivial', '--review', 'final'], withFlags.d);
    expect(withFlags.io.output()).not.toContain('Qual o tamanho');
    expect(withFlags.io.output()).not.toContain('Como revisar');

    const asked = await deps(['2', '', 'aprovar']); // 2 = trivial, Enter = default review
    await main(['x'], asked.d);
    expect(asked.io.output()).toContain('Qual o tamanho da tarefa?');
    expect(asked.io.output()).toContain('Como revisar?');
    expect(asked.s.configs[0]?.review_mode).toBe('final');
  });

  it('--review per_task and --no-arena change the config the run uses', async () => {
    const { d, s } = await deps(['aprovar']);
    await main(
      ['x', '--size', 'trivial', '--review', 'per_task', '--no-arena'],
      d,
    );
    expect(s.configs[0]?.review_mode).toBe('per_task');
    expect(s.configs[0]?.dev.arena.candidates).toBe(1);
  });

  it('keeps the arena off unless --arena opts in', async () => {
    const off = await deps(['aprovar']);
    await main(['x', '--size', 'trivial', '--review', 'final'], off.d);
    expect(off.s.configs[0]?.dev.arena.enabled).toBe(false);

    const on = await deps(['aprovar']);
    await main(
      ['x', '--size', 'trivial', '--review', 'final', '--arena', '2'],
      on.d,
    );
    expect(on.s.configs[0]?.dev.arena.enabled).toBe(true);
    expect(on.s.configs[0]?.dev.arena.candidates).toBe(2);
  });

  it('asks how to run the Dev, and the arena per task sets one Dev per task', async () => {
    // 1 = completo, 1 = review no final, 3 = arena por tarefa
    const { d, io, s, cwd } = await deps(['1', '1', '3', 'aprovar']);
    await main(['x'], d);
    expect(io.output()).toContain('Como rodar o Dev?');
    expect(io.output()).toContain('3) arena por tarefa');
    const config = s.configs[0];
    expect(config?.dev.arena.enabled).toBe(true);
    expect(config?.dev.batching).toBe('per_task');
    expect(config?.review_mode).toBe('final');
    const runs = join(cwd, '.workflow', 'runs');
    const [id] = await readdir(runs);
    const saved = JSON.parse(
      await readFile(join(runs, id ?? '', 'choices.json'), 'utf-8'),
    );
    expect(saved).toEqual({
      review_mode: 'final',
      arena: true,
      batching: 'per_task',
    });
  });

  it('arena once keeps one Dev for all tasks, and Enter keeps the arena off', async () => {
    const once = await deps(['1', '1', '2', 'aprovar']);
    await main(['x'], once.d);
    expect(once.s.configs[0]?.dev.arena.enabled).toBe(true);
    expect(once.s.configs[0]?.dev.batching).toBe('all');

    const enter = await deps(['1', '1', '', 'aprovar']);
    await main(['x'], enter.d);
    expect(enter.s.configs[0]?.dev.arena.enabled).toBe(false);
  });

  it('does not ask about the arena for a trivial task or when --arena/--no-arena decides it', async () => {
    const trivial = await deps(['2', '', 'aprovar']); // 2 = trivial
    await main(['x'], trivial.d);
    expect(trivial.io.output()).not.toContain('Como rodar o Dev?');

    const flagged = await deps(['2', '', 'aprovar']);
    await main(['x', '--no-arena'], flagged.d);
    expect(flagged.io.output()).not.toContain('Como rodar o Dev?');
  });

  it('refuses without a TTY, in one line, before any model call', async () => {
    const { d, io, s } = await deps([], scripted(), { isTTY: false });
    expect(await main(['x'], d)).toBe(1);
    expect(io.output()).toContain('terminal interativo');
    expect(s.calls).toEqual([]);
  });

  it('prints the usage for --help and for a bad flag', async () => {
    const a = await deps([]);
    expect(await main(['--help'], a.d)).toBe(0);
    expect(a.io.output()).toContain('Uso: forge-jj');
    const b = await deps([]);
    expect(await main(['x', '--size', 'enorme'], b.d)).toBe(2);
    expect(b.io.output()).toContain('--size');
  });

  it('without arguments and nothing to resume, says so in one line', async () => {
    const { d, io } = await deps([]);
    expect(await main([], d)).toBe(0);
    expect(io.output()).toContain('Não há execução incompleta');
  });

  it('an interruption leaves the run resumable; forge-jj with no arguments finishes it, even with a dirty tree', async () => {
    const s = scripted({
      dev: async (cwd, call) => {
        await writeFile(join(cwd, `out-${call}.txt`), 'x');
        if (call === 1) throw new Error('queda de energia');
        return '1. Corrigido: ok';
      },
    });
    const first = await deps(['aprovar'], s);
    expect(
      await main(['x', '--size', 'trivial', '--review', 'final'], first.d),
    ).toBe(130);
    expect(first.io.output()).toContain(
      'Rode `forge-jj` sem argumentos para retomar',
    );
    expect((await findIncompleteRun(first.cwd))?.state.task).toBe('x');
    expect(await git(first.cwd, ['status', '--porcelain'])).not.toBe('');

    const second = createFakeIO(['aprovar']);
    const code = await main([], { ...first.d, io: second });
    expect(code).toBe(0);
    expect(second.output()).toContain('Retomando: "x"');
    expect(await findIncompleteRun(first.cwd)).toBeNull();
    // Grill, recon and tasks did not run again
    expect(s.calls.filter((c) => c === 'recon')).toHaveLength(1);
    expect(s.calls.filter((c) => c === 'tasks')).toHaveLength(1);
  });

  it('stops for the human when the review keeps finding problems', async () => {
    const s = scripted({ lead: () => REJECT });
    const { d, io } = await deps(['aprovar'], s);
    expect(await main(['x', '--size', 'trivial', '--review', 'final'], d)).toBe(
      1,
    );
    expect(io.output()).toContain('Parei para você decidir');
    expect(io.output()).toContain('limite de 10 ciclos');
  });

  it('cancelling at the human stop ends cleanly', async () => {
    const { d, io, s } = await deps(['cancelar']);
    expect(await main(['x', '--size', 'trivial', '--review', 'final'], d)).toBe(
      0,
    );
    expect(io.output()).toContain('Execução cancelada');
    expect(s.calls).not.toContain('dev');
  });

  it('creates the default .workflow.yml before loading the config, and never rewrites it', async () => {
    const { d, cwd, io, s } = await deps(['cancelar', 'cancelar']);
    const file = join(cwd, '.workflow.yml');
    await rm(file);
    const argv = ['x', '--size', 'trivial', '--review', 'final'];
    expect(await main(argv, d)).toBe(0);
    const created = await readFile(file, 'utf8');
    expect(created).toBe(DEFAULT_WORKFLOW_YML);
    expect(io.output()).toContain('Criei .workflow.yml com o workflow padrão.');
    expect(s.configs[0]?.steps.dev.model).toBe('claude-sonnet-5-5');
    expect(await git(cwd, ['status', '--porcelain'])).toBe('');

    const before = io.output().split('Criei .workflow.yml').length;
    expect(await main(argv, d)).toBe(0);
    expect(io.output().split('Criei .workflow.yml').length).toBe(before);
    expect(await readFile(file, 'utf8')).toBe(created);
  });

  it('never leaves the repo lock behind', async () => {
    const { d, cwd } = await deps(['cancelar']);
    await main(['x', '--size', 'trivial'], d);
    await expect(
      readFile(join(cwd, '.workflow', 'lock'), 'utf-8'),
    ).rejects.toThrow();
    execFileSync('git', ['status'], { cwd });
  });
});
