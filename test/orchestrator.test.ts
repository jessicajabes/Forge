import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import {
  PIPELINE,
  RunCancelled,
  runWorkflow,
  type RunContext,
} from '../src/orchestrator.js';
import type { ProgressEvent } from '../src/progress.js';
import { createProgressReporter } from '../src/progressReporter.js';
import { createRun } from '../src/runs.js';
import { stubStages } from '../src/steps/stub.js';
import { createFakeRunner } from './fakeRunner.js';
import { makeRepo } from './helpers.js';

const SPEC = `# Spec: Teste

## Objetivo
Provar o encanamento.

## Decisões
- Usar um Runner falso

## Fora do escopo
- nenhum

## Restrições
- nenhuma

## Pontos em aberto
- nenhum
`;

const TASKS = `# Tarefas

## T1: Única tarefa
- **Arquivos**: src/a.ts
- **O que fazer**: Algo.
- **Critério de aceite**:
  - [ ] \`npm test\` passa
- **Depende de**: nenhuma
`;

async function setup(size: RunContext['size']) {
  const cwd = await makeRepo();
  const run = await createRun(cwd, 'tarefa de teste');
  const ctxBase = {
    cwd,
    task: 'tarefa de teste',
    size,
    run,
    config: parseConfig(''),
  };
  return ctxBase;
}

describe('runWorkflow', () => {
  it('runs the stages in the order of the design and saves the artifacts', async () => {
    const base = await setup('complete');
    const fake = createFakeRunner([
      SPEC,
      'contexto',
      TASKS,
      'dev feito',
      'revisão ok',
      '- lição',
    ]);
    const result = await runWorkflow(
      { ...base, runner: fake.runner },
      stubStages(),
    );

    expect(result.status).toBe('completed');
    expect(result.stagesRun).toEqual([...PIPELINE]);
    expect(fake.calls.map((c) => c.prompt.split('\n')[0])).toEqual([
      'stage:grill',
      'stage:recon',
      'stage:tasks',
      'stage:dev',
      'stage:review',
      'stage:lessons',
    ]);
    expect(fake.calls.map((c) => c.canEdit)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
    ]);

    const dir = base.run.dir;
    expect(await readFile(join(dir, 'spec.md'), 'utf-8')).toBe(SPEC);
    expect(await readFile(join(dir, 'context.md'), 'utf-8')).toBe('contexto');
    expect(await readFile(join(dir, 'tasks.md'), 'utf-8')).toBe(TASKS);
    expect(await readFile(join(dir, 'review.md'), 'utf-8')).toBe('revisão ok');
    expect(
      await readFile(join(base.cwd, '.workflow', 'lessons.md'), 'utf-8'),
    ).toBe('- lição');
  });

  it('emits an entry and an exit line for each stage, in order', async () => {
    const base = await setup('complete');
    const fake = createFakeRunner([
      SPEC,
      'contexto',
      TASKS,
      'dev feito',
      'revisão ok',
      '- lição',
    ]);
    const events: ProgressEvent[] = [];
    const lines: string[] = [];
    const reporter = createProgressReporter({
      write: async (event) => {
        events.push(event);
      },
      stream: { write: (text) => lines.push(text) },
      env: {},
    });
    await runWorkflow({ ...base, runner: fake.runner, reporter }, stubStages());

    const stageEvents = events.flatMap((e) => (e.type === 'stage' ? [e] : []));
    expect(
      stageEvents.map((e) => [e.stage, e.phase, e.index, e.total]),
    ).toEqual(
      PIPELINE.flatMap((name, i) => [
        [name, 'start', i + 1, 6],
        [name, 'end', i + 1, 6],
      ]),
    );
    expect(lines[0]).toContain('etapa grill (1/6)');
    expect(lines.some((l) => l.includes('etapa build (5/6)'))).toBe(true);
    expect(lines).toHaveLength(12);
  });

  it('does not count the skipped Grill in the stage positions', async () => {
    const base = await setup('trivial');
    const fake = createFakeRunner([
      'contexto',
      TASKS,
      'dev feito',
      'revisão ok',
      '- lição',
    ]);
    const events: ProgressEvent[] = [];
    const reporter = createProgressReporter({
      write: async (event) => {
        events.push(event);
      },
      stream: { write: () => true },
      quiet: true,
    });
    await runWorkflow({ ...base, runner: fake.runner, reporter }, stubStages());
    const starts = events.flatMap((e) =>
      e.type === 'stage' && e.phase === 'start' ? [e] : [],
    );
    expect(starts.map((e) => `${e.stage} ${e.index}/${e.total}`)).toEqual([
      'recon 1/5',
      'tasks 2/5',
      'approve 3/5',
      'build 4/5',
      'lessons 5/5',
    ]);
  });

  it('skips the Grill on a trivial task', async () => {
    const base = await setup('trivial');
    const fake = createFakeRunner([
      'contexto',
      TASKS,
      'dev feito',
      'revisão ok',
      '- lição',
    ]);
    const result = await runWorkflow(
      { ...base, runner: fake.runner },
      stubStages(),
    );
    expect(result.stagesRun).not.toContain('grill');
    expect(fake.calls).toHaveLength(5);
  });

  it('stops on a cancellation and does not run the later stages', async () => {
    const base = await setup('complete');
    const fake = createFakeRunner([SPEC, 'contexto', TASKS]);
    const stages = stubStages();
    stages.approve = async () => {
      throw new RunCancelled();
    };
    const result = await runWorkflow({ ...base, runner: fake.runner }, stages);
    expect(result.status).toBe('cancelled');
    expect(result.stagesRun).toEqual(['grill', 'recon', 'tasks']);
    expect(fake.calls).toHaveLength(3);
  });

  it('gives a stage with an empty error message the reason "erro"', async () => {
    const base = await setup('complete');
    const fake = createFakeRunner([SPEC, 'contexto', TASKS]);
    const events: ProgressEvent[] = [];
    const reporter = createProgressReporter({
      write: async (event) => {
        events.push(event);
      },
      stream: { write: () => true },
      quiet: true,
    });
    const stages = stubStages();
    stages.approve = async () => {
      throw new Error('');
    };
    await expect(
      runWorkflow({ ...base, runner: fake.runner, reporter }, stages),
    ).rejects.toThrow();
    const failed = events.find(
      (e) => e.type === 'stage' && e.phase === 'end' && e.ok === false,
    );
    expect(failed).toMatchObject({ reason: 'erro' });
  });

  it('reports a failing or cancelled stage as not ok', async () => {
    const base = await setup('complete');
    const fake = createFakeRunner([SPEC, 'contexto', TASKS]);
    const events: ProgressEvent[] = [];
    const reporter = createProgressReporter({
      write: async (event) => {
        events.push(event);
      },
      stream: { write: () => true },
      quiet: true,
    });
    const stages = stubStages();
    stages.approve = async () => {
      throw new RunCancelled();
    };
    await runWorkflow({ ...base, runner: fake.runner, reporter }, stages);
    const ends = events.flatMap((e) =>
      e.type === 'stage' && e.phase === 'end' ? [e] : [],
    );
    expect(ends.map((e) => [e.stage, e.ok])).toEqual([
      ['grill', true],
      ['recon', true],
      ['tasks', true],
      ['approve', false],
    ]);
    expect(ends[3]?.reason).toBe('cancelada');

    const failing = await setup('complete');
    const failEvents: ProgressEvent[] = [];
    const failReporter = createProgressReporter({
      write: async (event) => {
        failEvents.push(event);
      },
      stream: { write: () => true },
      quiet: true,
    });
    await expect(
      runWorkflow(
        {
          ...failing,
          runner: createFakeRunner(['not a spec']).runner,
          reporter: failReporter,
        },
        stubStages(),
      ),
    ).rejects.toThrow(/spec.md/);
    const last = failEvents.at(-1);
    expect(last).toMatchObject({ type: 'stage', phase: 'end', ok: false });
  });

  it('lets other errors through', async () => {
    const base = await setup('complete');
    const fake = createFakeRunner(['not a spec']);
    await expect(
      runWorkflow({ ...base, runner: fake.runner }, stubStages()),
    ).rejects.toThrow(/spec.md/);
  });
});
