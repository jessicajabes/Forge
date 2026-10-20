import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import {
  runWorkflow,
  RunCancelled,
  type RunContext,
} from '../src/orchestrator.js';
import { createRun } from '../src/runs.js';
import {
  NOTHING_TO_RESUME,
  findIncompleteRun,
  readState,
} from '../src/state.js';
import { stubStages } from '../src/steps/stub.js';
import { createFakeRunner } from './fakeRunner.js';
import { makeRepo } from './helpers.js';

const SPEC = `# Spec: T

## Objetivo
x

## Decisões
- a

## Fora do escopo
- nenhum

## Restrições
- nenhuma

## Pontos em aberto
- nenhum
`;
const TASKS = `# Tarefas

## T1: Única
- **Arquivos**: src/a.ts
- **O que fazer**: Algo.
- **Critério de aceite**:
  - [ ] \`npm test\` passa
- **Depende de**: nenhuma
`;

async function ctxFor(
  cwd: string,
  task: string,
): Promise<Omit<RunContext, 'runner'>> {
  return {
    cwd,
    task,
    size: 'complete',
    run: await createRun(cwd, task),
    config: parseConfig(''),
  };
}

describe('resume', () => {
  it('resumes after Tasks without repeating Grill or Recon', async () => {
    const cwd = await makeRepo();
    const base = await ctxFor(cwd, 'tarefa');

    // first run: interrupted at the human stop by a crash (not a cancellation)
    const first = createFakeRunner([SPEC, 'contexto', TASKS]);
    const stages = stubStages();
    stages.approve = async () => {
      throw new Error('queda de energia');
    };
    await expect(
      runWorkflow({ ...base, runner: first.runner }, stages),
    ).rejects.toThrow(/queda/);
    expect((await readState(base.run.dir))?.completed).toEqual([
      'grill',
      'recon',
      'tasks',
    ]);

    const found = await findIncompleteRun(cwd);
    expect(found?.run.dir).toBe(base.run.dir);
    expect(found?.state.task).toBe('tarefa');

    // second run on the same folder: only Dev, Review and Lessons call the runner
    const second = createFakeRunner(['dev', 'review', 'lições']);
    const result = await runWorkflow(
      { ...base, runner: second.runner },
      stubStages(),
    );
    expect(result.status).toBe('completed');
    expect(result.stagesRun).toEqual(['approve', 'build', 'lessons']);
    expect(second.calls.map((c) => c.prompt.split('\n')[0])).toEqual([
      'stage:dev',
      'stage:review',
      'stage:lessons',
    ]);
    expect(await findIncompleteRun(cwd)).toBeNull();
  });

  it('finds nothing to resume when every run is completed or cancelled', async () => {
    const cwd = await makeRepo();
    expect(await findIncompleteRun(cwd)).toBeNull();

    const done = await ctxFor(cwd, 'concluída');
    await runWorkflow(
      {
        ...done,
        runner: createFakeRunner([SPEC, 'c', TASKS, 'd', 'r', 'l']).runner,
      },
      stubStages(),
    );
    const cancelled = await ctxFor(cwd, 'cancelada');
    const stages = stubStages();
    stages.approve = async () => {
      throw new RunCancelled();
    };
    await runWorkflow(
      { ...cancelled, runner: createFakeRunner([SPEC, 'c', TASKS]).runner },
      stages,
    );

    expect(await findIncompleteRun(cwd)).toBeNull();
    expect(NOTHING_TO_RESUME).toMatch(/^Não há execução incompleta/);
    expect(NOTHING_TO_RESUME).not.toContain('\n');
  });

  it('picks the most recently updated incomplete run', async () => {
    const cwd = await makeRepo();
    const crash = async (task: string) => {
      const base = await ctxFor(cwd, task);
      const stages = stubStages();
      stages.grill = async () => {
        throw new Error('falha');
      };
      await runWorkflow(
        { ...base, runner: createFakeRunner([]).runner },
        stages,
      ).catch(() => undefined);
      return base;
    };
    await crash('primeira');
    await new Promise((r) => setTimeout(r, 15));
    const second = await crash('segunda');
    expect((await findIncompleteRun(cwd))?.run.dir).toBe(second.run.dir);
  });
});

describe('resume keeps the branch name and the local date', () => {
  it('a resumed run gets the same slug, so the branch is forge/<slug> and not forge/<date>-<slug>', async () => {
    const cwd = await makeRepo();
    const base = await ctxFor(cwd, 'adicionar login');
    const stages = stubStages();
    stages.grill = async () => {
      throw new Error('queda');
    };
    await runWorkflow(
      { ...base, runner: createFakeRunner([]).runner },
      stages,
    ).catch(() => undefined);
    const found = await findIncompleteRun(cwd);
    expect(found?.run.slug).toBe('adicionar-login');
    expect(found?.run.id).toMatch(/^\d{4}-\d{2}-\d{2}-adicionar-login$/);
  });

  it('a state saved before the slug existed falls back to the id without its date', async () => {
    const cwd = await makeRepo();
    const base = await ctxFor(cwd, 'tarefa antiga');
    const { writeFile, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const stages = stubStages();
    stages.grill = async () => {
      throw new Error('queda');
    };
    await runWorkflow(
      { ...base, runner: createFakeRunner([]).runner },
      stages,
    ).catch(() => undefined);
    const path = join(base.run.dir, 'state.json');
    const state = JSON.parse(await readFile(path, 'utf-8')) as Record<
      string,
      unknown
    >;
    delete state['slug'];
    await writeFile(path, JSON.stringify(state));
    expect((await findIncompleteRun(cwd))?.run.slug).toBe('tarefa-antiga');
  });
});
