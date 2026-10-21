import { describe, expect, it } from 'vitest';
import { checkout, currentBranch, git, listBranches } from '../src/git.js';
import { createRun, ensureLocalExclude } from '../src/runs.js';
import { readState, writeState } from '../src/state.js';
import {
  commitSubject,
  ensureBranch,
  splitBatches,
  taskBlocks,
} from '../src/steps/dev.js';
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

  it('does not create a branch: it stays on the current one and stores it in state.json', async () => {
    const { cwd, run } = await setup();
    const before = await currentBranch(cwd);
    expect(await ensureBranch(cwd, run)).toBe(before);
    expect(await currentBranch(cwd)).toBe(before);
    expect((await readState(run.dir))?.branch).toBe(before);
    expect(await listBranches(cwd, 'forge/')).toEqual([]);
  });

  it('refuses a detached HEAD, which has no branch name to commit under', async () => {
    const { cwd, run } = await setup();
    await git(cwd, ['checkout', '-q', '--detach']);
    await expect(ensureBranch(cwd, run)).rejects.toThrow(/HEAD solto/);
  });

  it('every commit subject starts with the branch name', async () => {
    const { cwd } = await setup();
    await checkout(cwd, 'TPC-8890', true);
    expect(await commitSubject(cwd, 'T1 - Tarefa 1')).toBe(
      'TPC-8890 - T1 - Tarefa 1',
    );
  });
});
