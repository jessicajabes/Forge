import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { currentBranch, git } from '../src/git.js';
import type { RunContext } from '../src/orchestrator.js';
import type { Runner } from '../src/runner.js';
import { createRun, ensureLocalExclude } from '../src/runs.js';
import { createDevStage, splitBatches, taskBlocks } from '../src/steps/dev.js';
import { parseTasks } from '../src/artifacts.js';
import { createFakeIO } from './fakeIO.js';
import { makeRepo } from './helpers.js';

const task = (n: number) => `## T${n}: Tarefa ${n}
- **Arquivos**: src/f${n}.ts
- **O que fazer**: Fazer ${n}.
- **Critério de aceite**:
  - [ ] \`npm test\` passa
- **Depende de**: nenhuma
`;
const TASKS = `# Tarefas\n\n${[1, 2, 3].map(task).join('\n')}`;

async function setup(yml = '') {
  const cwd = await makeRepo();
  await ensureLocalExclude(cwd); // preflight does this before any stage runs
  const run = await createRun(cwd, 'adicionar coisas');
  await writeFile(join(run.dir, 'tasks.md'), TASKS);
  await writeFile(join(run.dir, 'spec.md'), '# Spec: x\n');
  const prompts: string[] = [];
  const edits: boolean[] = [];
  let n = 0;
  const runner: Runner = async (req) => {
    prompts.push(req.prompt);
    edits.push(req.canEdit);
    n++;
    await writeFile(join(cwd, `feature-${n}.txt`), `change ${n}\n`);
    return `relatório ${n}`;
  };
  const ctx: RunContext = {
    cwd,
    task: 'adicionar coisas',
    size: 'complete',
    run,
    config: parseConfig(yml),
    runner,
  };
  return { ctx, prompts, edits };
}

describe('batches', () => {
  it('final is one batch with every task; per_task is one batch per task', () => {
    const { tasks } = parseTasks(TASKS);
    expect(splitBatches(tasks, 'final')).toHaveLength(1);
    expect(splitBatches(tasks, 'final')[0]?.tasks).toHaveLength(3);
    expect(splitBatches(tasks, 'per_task').map((b) => b.tasks.length)).toEqual([
      1, 1, 1,
    ]);
  });

  it('extracts the block of each task', () => {
    const blocks = taskBlocks(TASKS);
    expect([...blocks.keys()]).toEqual([1, 2, 3]);
    expect(blocks.get(2)).toContain('## T2: Tarefa 2');
    expect(blocks.get(2)).not.toContain('T3');
  });
});

describe('dev stage', () => {
  it('works on a branch forge/<slug> and makes one commit for the whole run in final mode', async () => {
    const { ctx, edits } = await setup();
    await createDevStage({ io: createFakeIO([]) })(ctx);
    expect(await currentBranch(ctx.cwd)).toBe('forge/adicionar-coisas');
    expect(edits).toEqual([true]);
    const count = await git(ctx.cwd, [
      'rev-list',
      '--count',
      'feature/x..HEAD',
    ]);
    expect(count).toBe('1');
    const message = await git(ctx.cwd, ['log', '-1', '--format=%B']);
    expect(message).toContain(`Forge-Run: ${ctx.run.id}`);
    expect(message).toContain('Forge-Batch: 1');
    expect(message).toContain('Forge-Tasks: T1, T2, T3');
  });

  it('per_task makes one batch and one commit per task, each prompt with only its own task', async () => {
    const { ctx, prompts } = await setup('review_mode: per_task');
    await createDevStage({ io: createFakeIO([]) })(ctx);
    expect(await git(ctx.cwd, ['rev-list', '--count', 'feature/x..HEAD'])).toBe(
      '3',
    );
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('## T2: Tarefa 2');
    expect(prompts[1]).not.toContain('## T1: Tarefa 1');
    expect(prompts[1]).not.toContain('## T3: Tarefa 3');
    expect(prompts[0]).toContain('Batch 1 of 3');
  });

  it('puts the allowed commands and the tasks file path in the prompt', async () => {
    const { ctx, prompts } = await setup();
    await createDevStage({ io: createFakeIO([]) })(ctx);
    expect(prompts[0]).toContain('- npm test');
    expect(prompts[0]).toContain(join(ctx.run.dir, 'tasks.md'));
    expect(await readFile(join(ctx.run.dir, 'dev-batch-1.md'), 'utf-8')).toBe(
      'relatório 1',
    );
  });

  it('never pushes: a remote stays empty', async () => {
    const { ctx } = await setup('review_mode: per_task');
    const remote = await mkdtemp(join(tmpdir(), 'forge-remote-'));
    execFileSync('git', ['init', '-q', '--bare'], { cwd: remote });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: ctx.cwd });
    await createDevStage({ io: createFakeIO([]) })(ctx);
    expect(
      execFileSync('git', ['for-each-ref'], { cwd: remote }).toString(),
    ).toBe('');
  });

  it('does not commit when the Dev changed nothing, and says so', async () => {
    const { ctx } = await setup();
    ctx.runner = async () => 'nada a fazer';
    const io = createFakeIO([]);
    await createDevStage({ io })(ctx);
    expect(await git(ctx.cwd, ['rev-list', '--count', 'feature/x..HEAD'])).toBe(
      '0',
    );
    expect(io.output()).toContain('não mudou nada');
  });

  it('a resumed run skips the batches already committed', async () => {
    const { ctx, prompts } = await setup('review_mode: per_task');
    // first attempt dies after the first batch
    let calls = 0;
    const real = ctx.runner;
    ctx.runner = async (req) => {
      if (++calls === 2) throw new Error('queda');
      return real(req);
    };
    await expect(createDevStage({ io: createFakeIO([]) })(ctx)).rejects.toThrow(
      'queda',
    );
    expect(await git(ctx.cwd, ['rev-list', '--count', 'feature/x..HEAD'])).toBe(
      '1',
    );

    ctx.runner = real;
    prompts.length = 0;
    await createDevStage({ io: createFakeIO([]) })(ctx);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Batch 2 of 3');
    expect(await git(ctx.cwd, ['rev-list', '--count', 'feature/x..HEAD'])).toBe(
      '3',
    );
  });
});
