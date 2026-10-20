import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { currentBranch, git } from '../src/git.js';
import type { RunContext } from '../src/orchestrator.js';
import type { Runner, RunnerFactory } from '../src/runner.js';
import { createRun, ensureLocalExclude } from '../src/runs.js';
import { createBuildStage } from '../src/steps/build.js';
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
const APPROVED = JSON.stringify({
  verdict: 'approved',
  act_on: [],
  consider: [],
  noted: [],
  dismissed: [],
});

/** Reviewers say "no findings" and the lead approves. */
const approvingRunners: RunnerFactory = () => async (req) =>
  req.prompt.includes('adversarial code reviewer')
    ? '## Findings\n\nno findings'
    : APPROVED;

async function setup(yml = '') {
  const cwd = await makeRepo();
  await ensureLocalExclude(cwd);
  const run = await createRun(cwd, 'adicionar coisas');
  await writeFile(join(run.dir, 'tasks.md'), TASKS);
  await writeFile(
    join(run.dir, 'spec.md'),
    '# Spec: x\n\n## Objetivo\nFazer coisas.\n\n## Decisões\n- a\n\n## Fora do escopo\n- nenhum\n\n## Restrições\n- nenhuma\n\n## Pontos em aberto\n- nenhum\n',
  );
  const config = parseConfig(yml);
  config.dev.arena.candidates = 1; // plain Dev here; the arena has its own tests
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
    config,
    runner,
  };
  return { ctx, prompts, edits };
}

const stage = (io = createFakeIO([])) =>
  createBuildStage({ io, makeRunner: approvingRunners });
const commitsAhead = (cwd: string) =>
  git(cwd, ['rev-list', '--count', 'feature/x..HEAD']);

describe('build stage', () => {
  it('works on a branch forge/<slug> and makes one commit for the whole run in final mode', async () => {
    const { ctx, edits } = await setup();
    await stage()(ctx);
    expect(await currentBranch(ctx.cwd)).toBe('forge/adicionar-coisas');
    expect(edits).toEqual([true]);
    expect(await commitsAhead(ctx.cwd)).toBe('1');
    const message = await git(ctx.cwd, ['log', '-1', '--format=%B']);
    expect(message).toContain(`Forge-Run: ${ctx.run.id}`);
    expect(message).toContain('Forge-Batch: 1');
    expect(message).toContain('Forge-Tasks: T1, T2, T3');
  });

  it('per_task makes one batch and one commit per task, each prompt with only its own task', async () => {
    const { ctx, prompts } = await setup('review_mode: per_task');
    await stage()(ctx);
    expect(await commitsAhead(ctx.cwd)).toBe('3');
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('## T2: Tarefa 2');
    expect(prompts[1]).not.toContain('## T1: Tarefa 1');
    expect(prompts[1]).not.toContain('## T3: Tarefa 3');
    expect(prompts[0]).toContain('Batch 1 of 3');
  });

  it('puts the allowed commands and the tasks file path in the Dev prompt', async () => {
    const { ctx, prompts } = await setup();
    await stage()(ctx);
    expect(prompts[0]).toContain('- npm test');
    expect(prompts[0]).toContain(join(ctx.run.dir, 'tasks.md'));
    expect(await readFile(join(ctx.run.dir, 'dev-batch-1.md'), 'utf-8')).toBe(
      'relatório 1',
    );
  });

  it('writes review.md at the end', async () => {
    const { ctx } = await setup();
    await stage()(ctx);
    const review = await readFile(join(ctx.run.dir, 'review.md'), 'utf-8');
    expect(review).toContain('- **Veredito**: aprovado');
    expect(review).toContain('- **Ciclos realizados**: 1 de 3');
  });

  it('with several batches, review.md has one section per batch', async () => {
    const { ctx } = await setup('review_mode: per_task');
    await stage()(ctx);
    const review = await readFile(join(ctx.run.dir, 'review.md'), 'utf-8');
    expect(review).toContain('## Lote 1 de 3');
    expect(review).toContain('## Lote 3 de 3');
  });

  it('never pushes: a remote stays empty', async () => {
    const { ctx } = await setup('review_mode: per_task');
    const remote = await mkdtemp(join(tmpdir(), 'forge-remote-'));
    execFileSync('git', ['init', '-q', '--bare'], { cwd: remote });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: ctx.cwd });
    await stage()(ctx);
    expect(
      execFileSync('git', ['for-each-ref'], { cwd: remote }).toString(),
    ).toBe('');
  });

  it('does not commit when nothing changed, and says so', async () => {
    const { ctx } = await setup();
    ctx.runner = async () => 'nada a fazer';
    const io = createFakeIO([]);
    await stage(io)(ctx);
    expect(await commitsAhead(ctx.cwd)).toBe('0');
    expect(io.output()).toContain('sem mudanças para commitar');
  });

  it('a resumed run skips the batches already committed', async () => {
    const { ctx, prompts } = await setup('review_mode: per_task');
    let calls = 0;
    const real = ctx.runner;
    ctx.runner = async (req) => {
      if (++calls === 2) throw new Error('queda');
      return real(req);
    };
    await expect(stage()(ctx)).rejects.toThrow('queda');
    expect(await commitsAhead(ctx.cwd)).toBe('1');

    ctx.runner = real;
    prompts.length = 0;
    await stage()(ctx);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Batch 2 of 3');
    expect(await commitsAhead(ctx.cwd)).toBe('3');
  });
});

describe('build stage with dev.batching per_task and the review at the end', () => {
  const yml = 'dev: { batching: per_task }';
  const finding = (title: string, taskId: string) => ({
    task: taskId,
    title,
    description: `${title} está errado`,
    raised_by: ['A'],
    rationale: 'importa',
  });

  function reviewRunners(leads: string[]) {
    const reviewerPrompts: string[] = [];
    let next = 0;
    const makeRunner: RunnerFactory = () => async (req) => {
      if (req.prompt.includes('adversarial code reviewer')) {
        reviewerPrompts.push(req.prompt);
        return '## Findings\n\nno findings';
      }
      return leads[next++] ?? APPROVED;
    };
    return { makeRunner, reviewerPrompts };
  }

  it('makes one Dev call and one commit per task, then one review of everything', async () => {
    const { ctx, prompts } = await setup(yml);
    const { makeRunner, reviewerPrompts } = reviewRunners([]);
    await createBuildStage({ io: createFakeIO([]), makeRunner })(ctx);

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('## T2: Tarefa 2');
    expect(prompts[1]).not.toContain('## T1: Tarefa 1');
    expect(await commitsAhead(ctx.cwd)).toBe('3');
    // one review, over the diff against the commit before the first task
    expect(reviewerPrompts).toHaveLength(1);
    for (const n of [1, 2, 3])
      expect(reviewerPrompts[0]).toContain(`feature-${n}.txt`);
    const review = await readFile(join(ctx.run.dir, 'review.md'), 'utf-8');
    expect(review).toContain('- **Veredito**: aprovado');
    expect(review).not.toContain('## Lote');
  });

  it('sends the review items back one Dev call per cited task and commits the corrections once', async () => {
    const { ctx, prompts } = await setup(yml);
    const rejected = JSON.stringify({
      verdict: 'rejected',
      act_on: [finding('Alfa', 'T2'), finding('Beta', 'T3')],
      consider: [],
      noted: [],
      dismissed: [],
    });
    const { makeRunner } = reviewRunners([rejected, APPROVED]);
    await createBuildStage({ io: createFakeIO([]), makeRunner })(ctx);

    expect(prompts).toHaveLength(5);
    expect(prompts[3]).toContain('## T2: Tarefa 2');
    expect(prompts[3]).toContain('[T2] Alfa');
    expect(prompts[3]).not.toContain('## T3: Tarefa 3');
    expect(prompts[4]).toContain('## T3: Tarefa 3');
    expect(prompts[4]).not.toContain('## T2: Tarefa 2');
    expect(await commitsAhead(ctx.cwd)).toBe('4');
    const message = await git(ctx.cwd, ['log', '-1', '--format=%B']);
    expect(message).toContain('Forge-Batch: review');
  });

  it('a failed task stops the run, and running again goes on from it without redoing the review', async () => {
    const { ctx, prompts } = await setup(yml);
    const { makeRunner, reviewerPrompts } = reviewRunners([]);
    let calls = 0;
    const real = ctx.runner;
    ctx.runner = async (req) => {
      if (++calls === 2) throw new Error('queda');
      return real(req);
    };
    await expect(
      createBuildStage({ io: createFakeIO([]), makeRunner })(ctx),
    ).rejects.toThrow('queda');
    expect(await commitsAhead(ctx.cwd)).toBe('1');
    expect(reviewerPrompts).toHaveLength(0);

    ctx.runner = real;
    prompts.length = 0;
    await createBuildStage({ io: createFakeIO([]), makeRunner })(ctx);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Batch 2 of 3');
    expect(reviewerPrompts).toHaveLength(1);
    expect(await commitsAhead(ctx.cwd)).toBe('3');

    prompts.length = 0;
    await createBuildStage({ io: createFakeIO([]), makeRunner })(ctx);
    expect(prompts).toHaveLength(0);
    expect(reviewerPrompts).toHaveLength(1);
  });

  it('does not redo a task that changed nothing when the run is resumed', async () => {
    const { ctx, prompts } = await setup(yml);
    const { makeRunner } = reviewRunners([]);
    let calls = 0;
    const real = ctx.runner;
    ctx.runner = async (req) => {
      calls++;
      if (calls === 1) return 'já estava pronto';
      if (calls === 3) throw new Error('queda');
      return real(req);
    };
    await expect(
      createBuildStage({ io: createFakeIO([]), makeRunner })(ctx),
    ).rejects.toThrow('queda');

    ctx.runner = real;
    prompts.length = 0;
    await createBuildStage({ io: createFakeIO([]), makeRunner })(ctx);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Batch 3 of 3');
  });
});
