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

  it('lets other errors through', async () => {
    const base = await setup('complete');
    const fake = createFakeRunner(['not a spec']);
    await expect(
      runWorkflow({ ...base, runner: fake.runner }, stubStages()),
    ).rejects.toThrow(/spec.md/);
  });
});
