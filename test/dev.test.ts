import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { branchName } from '../src/branchName.js';
import { checkout, currentBranch } from '../src/git.js';
import { createRun, ensureLocalExclude } from '../src/runs.js';
import { readState, writeState } from '../src/state.js';
import { ensureBranch, splitBatches, taskBlocks } from '../src/steps/dev.js';
import { makeRepo } from './helpers.js';
import { parseTasks } from '../src/artifacts.js';

const task = (n: number) => `## T${n}: Tarefa ${n}
- **Arquivos**: src/f${n}.ts
- **O que fazer**: Fazer ${n}.
- **Critério de aceite**:
  - [ ] \`npm test\` passa
- **Depende de**: nenhuma
`;
const TASKS = `# Tarefas\n\n${[1, 2, 3].map(task).join('\n')}`;

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

describe('ensureBranch', () => {
  async function setup() {
    const cwd = await makeRepo();
    await ensureLocalExclude(cwd);
    const run = await createRun(cwd, 'adicionar login');
    await writeState(run.dir, {
      task: 'adicionar login',
      slug: run.slug,
      size: 'complete',
      completed: [],
      status: 'running',
    });
    return { cwd, run };
  }

  it('creates forge/<creative name>, not the slug, and stores it in state.json', async () => {
    const { cwd, run } = await setup();
    const branch = await ensureBranch(cwd, run);
    expect(branch).toBe(branchName(run.id, []));
    expect(branch).not.toContain(run.slug);
    expect(await currentBranch(cwd)).toBe(branch);
    expect((await readState(run.dir))?.branch).toBe(branch);
    expect(await readFile(join(run.dir, 'state.json'), 'utf-8')).toContain(
      branch,
    );
  });

  it('a resumed run reuses the name stored in state.json', async () => {
    const { cwd, run } = await setup();
    const first = await ensureBranch(cwd, run);
    await checkout(cwd, 'feature/x');
    expect(await ensureBranch(cwd, run)).toBe(first);
    expect(await currentBranch(cwd)).toBe(first);
  });

  it('keeps a forge/* branch already checked out and records it in state.json', async () => {
    const { cwd, run } = await setup();
    await checkout(cwd, 'forge/outra', true);
    expect(await ensureBranch(cwd, run)).toBe('forge/outra');
    expect((await readState(run.dir))?.branch).toBe('forge/outra');
    await checkout(cwd, 'feature/x');
    expect(await ensureBranch(cwd, run)).toBe('forge/outra');
    expect(await currentBranch(cwd)).toBe('forge/outra');
  });

  it('the stored branch wins over another forge/* branch checked out', async () => {
    const { cwd, run } = await setup();
    const first = await ensureBranch(cwd, run);
    await checkout(cwd, 'forge/outra', true);
    expect(await ensureBranch(cwd, run)).toBe(first);
    expect(await currentBranch(cwd)).toBe(first);
  });
});
