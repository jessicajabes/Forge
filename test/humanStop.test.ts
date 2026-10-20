import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { estimateDevCost } from '../src/costEstimate.js';
import { RunCancelled, type RunContext } from '../src/orchestrator.js';
import { createRun } from '../src/runs.js';
import { createHumanStop } from '../src/steps/humanStop.js';
import { createFakeIO } from './fakeIO.js';
import { createFakeRunner } from './fakeRunner.js';
import { makeRepo } from './helpers.js';

const task = (n: number) => `## T${n}: Tarefa ${n}
- **Arquivos**: src/a${n}.ts
- **O que fazer**: Algo.
- **Critério de aceite**:
  - [ ] \`npm test\` passa
- **Depende de**: nenhuma
`;
const TASKS3 = `# Tarefas\n\n${[1, 2, 3].map(task).join('\n')}`;
const TASKS3_DOUBT = `${TASKS3}\n## Dúvidas\n\n- Qual banco usar?\n`;

async function ctxWith(markdown: string, yml = ''): Promise<RunContext> {
  const cwd = await makeRepo();
  const run = await createRun(cwd, 'teste');
  await writeFile(join(run.dir, 'tasks.md'), markdown);
  return {
    cwd,
    task: 'teste',
    size: 'complete',
    run,
    config: parseConfig(yml),
    runner: createFakeRunner([]).runner,
  };
}

const noEditor = async () => undefined;

describe('human stop', () => {
  it('approve lets the flow go on and shows tasks, doubts and cost', async () => {
    const ctx = await ctxWith(TASKS3_DOUBT);
    const io = createFakeIO(['aprovar']);
    await createHumanStop(io, noEditor)(ctx);
    expect(io.output()).toContain('## T1: Tarefa 1');
    expect(io.output()).toContain('Qual banco usar?');
    expect(io.output()).toContain('Custo estimado do Dev');
    expect(ctx.config.dev.arena.candidates).toBe(3);
  });

  it('cancel throws RunCancelled', async () => {
    const ctx = await ctxWith(TASKS3);
    await expect(
      createHumanStop(createFakeIO(['cancelar']), noEditor)(ctx),
    ).rejects.toBeInstanceOf(RunCancelled);
  });

  it('"rodar sem arena" turns the arena off for this run and continues', async () => {
    const ctx = await ctxWith(TASKS3);
    await createHumanStop(createFakeIO(['rodar sem arena']), noEditor)(ctx);
    expect(ctx.config.dev.arena.candidates).toBe(1);
  });

  it('edit opens the editor, then shows the file again and waits for a new answer', async () => {
    const ctx = await ctxWith(TASKS3);
    const io = createFakeIO(['editar', 'aprovar']);
    let opened = '';
    await createHumanStop(io, async (path) => {
      opened = path;
      await writeFile(path, TASKS3.replace('Tarefa 1', 'Tarefa editada'));
    })(ctx);
    expect(opened).toBe(join(ctx.run.dir, 'tasks.md'));
    expect(io.output()).toContain('Tarefa editada');
    expect(await readFile(opened, 'utf-8')).toContain('Tarefa editada');
  });

  it('an invalid file after editing sends the person back instead of failing', async () => {
    const ctx = await ctxWith(TASKS3);
    const io = createFakeIO(['editar', 'editar', 'aprovar']);
    let calls = 0;
    await createHumanStop(io, async (path) => {
      calls++;
      await writeFile(path, calls === 1 ? 'lixo' : TASKS3);
    })(ctx);
    expect(io.output()).toContain('inválido');
  });

  it('asks again on an unknown answer', async () => {
    const ctx = await ctxWith(TASKS3);
    const io = createFakeIO(['talvez', 'a']);
    await createHumanStop(io, noEditor)(ctx);
    expect(io.output()).toContain('não reconhecida');
  });
});

describe('estimateDevCost', () => {
  it('is relative: 6 calls per batch with 3 candidates', () => {
    const e = estimateDevCost({
      config: parseConfig('review_mode: final'),
      taskCount: 3,
      size: 'complete',
    });
    expect(e.callsPerBatch).toBe(6);
    expect(e.batches).toBe(1);
    expect(e.totalCalls).toBe(6);
  });

  it('grows with review_mode per_task', () => {
    const e = estimateDevCost({
      config: parseConfig('review_mode: per_task'),
      taskCount: 3,
      size: 'complete',
    });
    expect(e.batches).toBe(3);
    expect(e.totalCalls).toBe(18);
    expect(e.text).toContain('3 lotes');
  });

  it('is 1 call per batch without the arena and on a trivial task', () => {
    const off = estimateDevCost({
      config: parseConfig('dev: { arena: { candidates: 1 } }'),
      taskCount: 2,
      size: 'complete',
    });
    const trivial = estimateDevCost({
      config: parseConfig(''),
      taskCount: 1,
      size: 'trivial',
    });
    expect(off.callsPerBatch).toBe(1);
    expect(trivial.callsPerBatch).toBe(1);
    expect(trivial.arena).toBe(false);
  });
});
