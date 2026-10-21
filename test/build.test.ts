import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runChecks } from '../src/arena.js';
import { parseConfig } from '../src/config.js';
import { currentBranch, git } from '../src/git.js';
import type { RunContext } from '../src/orchestrator.js';
import { createProgressReporter } from '../src/progressReporter.js';
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
  config.dev.check_commands = []; // the final checks have their own tests below
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
// the Forge commits on the branch itself, so count the commits after the initial one
const commitsAhead = async (cwd: string) =>
  String(Number(await git(cwd, ['rev-list', '--count', 'HEAD'])) - 1);

describe('build stage', () => {
  it('commits on the branch it is on, named in the subject, with one commit for the whole run in final mode', async () => {
    const { ctx, edits } = await setup('review_mode: final');
    await stage()(ctx);
    expect(await currentBranch(ctx.cwd)).toBe('feature/x');
    expect(await git(ctx.cwd, ['log', '-1', '--format=%s'])).toMatch(
      /^feature\/x - T1, T2, T3 - /,
    );
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
    expect(await readFile(join(ctx.run.dir, 'dev-lote-1.md'), 'utf-8')).toBe(
      'relatório 1',
    );
  });

  it('runs a plain Dev, not the arena, unless dev.arena.enabled is set', async () => {
    const { ctx, prompts, edits } = await setup('review_mode: final');
    ctx.config.dev.arena.candidates = 3; // candidates alone do not opt in
    await stage()(ctx);
    expect(edits).toEqual([true]);
    expect(prompts.some((p) => p.includes('preparing an arena'))).toBe(false);
  });

  it('runs the arena when dev.arena.enabled is set', async () => {
    const { ctx, prompts, edits } = await setup();
    ctx.config.dev.arena.enabled = true;
    ctx.config.dev.arena.candidates = 2;
    // the fake runner has no valid rubric, so the arena stops right after it starts
    await expect(stage()(ctx)).rejects.toThrow(/sem resposta válida.*: rubric/);
    expect(prompts[0]).toContain('preparing an arena');
    expect(edits).not.toContain(true); // no plain Dev call ran
  });

  it('writes review.md at the end', async () => {
    const { ctx } = await setup();
    await stage()(ctx);
    const review = await readFile(join(ctx.run.dir, 'review.md'), 'utf-8');
    expect(review).toContain('- **Veredito**: aprovado');
    expect(review).toContain('- **Ciclos realizados**: 1 de 10');
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
  const yml = 'review_mode: final\ndev: { batching: per_task }';
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

describe('build command progress lines', () => {
  it('emits [build] start and end lines with the duration, and not the raw output', async () => {
    const out: string[] = [];
    const events: string[] = [];
    let tick = 0;
    const reporter = createProgressReporter({
      write: async (event) => {
        events.push(event.type);
      },
      stream: { write: (text) => out.push(text), isTTY: false },
      env: {},
    });
    const results = await runChecks(
      process.cwd(),
      ['node --version', 'node --no-such-flag'],
      reporter,
      () => (tick += 42_000),
    );
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(out.join('')).toBe(
      [
        '[build] node --version',
        '[build] ok em 42s',
        '[build] node --no-such-flag',
        '[build] erro em 42s',
        '',
      ].join('\n'),
    );
    expect(events).toEqual(['step', 'step', 'step', 'step']);
  }, 20_000);
});

describe('build stage final checks', () => {
  const FAILING = 'final checks of the project failed';

  async function withCheck(yml = 'review_mode: per_task') {
    const s = await setup(yml);
    // passes only once the Dev has written fixed.txt
    await writeFile(
      join(s.ctx.cwd, 'check.js'),
      "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1);\n",
    );
    s.ctx.config.dev.check_commands = ['node check.js'];
    return s;
  }

  it('runs the checks once at the end, after the last review', async () => {
    const { ctx, prompts } = await withCheck();
    await writeFile(join(ctx.cwd, 'fixed.txt'), 'x');
    const io = createFakeIO([]);
    await stage(io)(ctx);
    expect(io.output()).toContain('Checks finais passaram.');
    expect(prompts.some((p) => p.includes(FAILING))).toBe(false);
  }, 30_000);

  it('sends a failing check back to the Dev, then commits the fix', async () => {
    const { ctx, prompts } = await withCheck();
    const inner = ctx.runner;
    ctx.runner = async (req) => {
      if (req.prompt.includes(FAILING))
        await writeFile(join(ctx.cwd, 'fixed.txt'), 'x');
      return inner(req);
    };
    await stage()(ctx);
    const fix = prompts.filter((p) => p.includes(FAILING));
    expect(fix).toHaveLength(1);
    expect(fix[0]).toContain('`node check.js`: falhou');
    const log = await git(ctx.cwd, ['log', '--format=%s']);
    expect(log).toContain('feature/x - correções dos checks finais');
  }, 30_000);

  it('reviews the Dev fix of a failing check before committing it', async () => {
    const { ctx } = await withCheck();
    const inner = ctx.runner;
    ctx.runner = async (req) => {
      if (req.prompt.includes(FAILING))
        await writeFile(join(ctx.cwd, 'fixed.txt'), 'x');
      return inner(req);
    };
    const reviewerDiffs: string[] = [];
    const makeRunner: RunnerFactory = (o) => async (req) => {
      if (req.prompt.includes('adversarial code reviewer'))
        reviewerDiffs.push(req.prompt);
      return approvingRunners(o)(req);
    };
    await createBuildStage({ io: createFakeIO([]), makeRunner })(ctx);
    // the 3 batches, then the fix of the check
    expect(reviewerDiffs.length).toBeGreaterThan(3);
    expect(reviewerDiffs.at(-1)).toContain('fixed.txt');
    expect(await readFile(join(ctx.run.dir, 'review.md'), 'utf-8')).toContain(
      '## Correções dos checks finais',
    );
    expect(await git(ctx.cwd, ['status', '--porcelain'])).toBe('');
  }, 30_000);

  it('stops the run when the checks still fail after the Dev fixes', async () => {
    const { ctx, prompts } = await withCheck();
    await expect(stage()(ctx)).rejects.toThrow(
      /checks finais ainda falham.*node check\.js/s,
    );
    expect(prompts.filter((p) => p.includes(FAILING))).toHaveLength(2);
  }, 30_000);

  it('runs a counting check exactly once across three per_task batches', async () => {
    const { ctx } = await setup('review_mode: per_task');
    await writeFile(
      join(ctx.cwd, 'count.js'),
      "require('fs').appendFileSync('runs.txt', 'x');\n",
    );
    ctx.config.dev.check_commands = ['node count.js'];
    await stage()(ctx);
    expect(await readFile(join(ctx.cwd, 'runs.txt'), 'utf-8')).toBe('x');
  }, 30_000);

  it('commits what an earlier stop left in the tree when the checks pass on resume', async () => {
    const { ctx } = await withCheck();
    await expect(stage()(ctx)).rejects.toThrow(/checks finais ainda falham/);
    // a person fixes it by hand and runs again
    await writeFile(join(ctx.cwd, 'fixed.txt'), 'x');
    await stage()(ctx);
    expect(await git(ctx.cwd, ['status', '--porcelain'])).toBe('');
    expect(await git(ctx.cwd, ['log', '--format=%s'])).toContain(
      'feature/x - correções dos checks finais',
    );
  }, 30_000);

  it('does nothing when there are no check commands', async () => {
    const { ctx } = await setup();
    const io = createFakeIO([]);
    await stage(io)(ctx);
    expect(io.output()).not.toContain('Checks finais');
  });
});

describe('build stage in the single-Dev flow', () => {
  it('runs the checks before the review, and files the documents by task', async () => {
    const s = await setup('review_mode: final');
    await writeFile(
      join(s.ctx.cwd, 'check.js'),
      "require('fs').appendFileSync('order.log', 'check\\n');\n",
    );
    s.ctx.config.dev.check_commands = ['node check.js'];
    const order: string[] = [];
    const makeRunner: RunnerFactory = () => async (req) => {
      if (req.prompt.includes('adversarial code reviewer')) {
        order.push('review');
        return '## Findings\n\nno findings';
      }
      return APPROVED;
    };
    const inner = s.ctx.runner;
    s.ctx.runner = async (req) => {
      order.push('dev');
      return inner(req);
    };
    await createBuildStage({ io: createFakeIO([]), makeRunner })(s.ctx);
    expect(order[0]).toBe('dev');
    expect(order).toContain('review');
    expect(
      await readFile(join(s.ctx.cwd, 'order.log'), 'utf-8').catch(() => ''),
    ).toBe('check\n');
    // the single Dev call is one batch, filed per task
    for (const id of [1, 2, 3]) {
      const dev = await readFile(
        join(s.ctx.run.dir, 'tarefas', `T${id}`, 'dev.md'),
        'utf-8',
      );
      expect(dev).toContain(`T${id}`);
    }
  }, 30_000);

  it('files the Dev report sections under the task each one names', async () => {
    const s = await setup('review_mode: final');
    s.ctx.runner = async () =>
      '## T1: Tarefa 1\n- **Feito**: um\n\n## T2: Tarefa 2\n- **Feito**: dois\n';
    await stage()(s.ctx);
    const t2 = await readFile(
      join(s.ctx.run.dir, 'tarefas', 'T2', 'dev.md'),
      'utf-8',
    );
    expect(t2).toContain('dois');
    expect(t2).not.toContain('um');
  });

  it('a resumed run does not redo the Dev when only the review was interrupted', async () => {
    const s = await setup('review_mode: final');
    let reviewing = true;
    const makeRunner: RunnerFactory = () => async (req) => {
      if (reviewing) throw new Error('queda no review');
      return req.prompt.includes('adversarial code reviewer')
        ? '## Findings\n\nno findings'
        : APPROVED;
    };
    await expect(
      createBuildStage({ io: createFakeIO([]), makeRunner })(s.ctx),
    ).rejects.toThrow();
    expect(s.edits).toEqual([true]); // the Dev ran once

    reviewing = false;
    const io = createFakeIO([]);
    await createBuildStage({ io, makeRunner })(s.ctx);
    expect(s.edits).toEqual([true]); // and not again
    expect(io.output()).toContain('o Dev já tinha terminado');
    expect(await commitsAhead(s.ctx.cwd)).toBe('1');
  }, 30_000);

  it('a resumed run does not redo the review that was already approved', async () => {
    const s = await setup('review_mode: final');
    const calls: string[] = [];
    const makeRunner: RunnerFactory = () => async (req) => {
      calls.push(req.prompt.slice(0, 20));
      return req.prompt.includes('adversarial code reviewer')
        ? '## Findings\n\nno findings'
        : APPROVED;
    };
    await createBuildStage({ io: createFakeIO([]), makeRunner })(s.ctx);
    const first = calls.length;
    // go back as if the run stopped right before the commit
    await git(s.ctx.cwd, ['reset', '--soft', 'HEAD~1']);
    await git(s.ctx.cwd, ['reset']);
    const io = createFakeIO([]);
    await createBuildStage({ io, makeRunner })(s.ctx);
    expect(calls.length).toBe(first);
    expect(io.output()).toContain('a revisão já tinha sido aprovada');
  }, 30_000);

  it('reviews the Dev fix of a check that failed after the review changed code', async () => {
    const s = await setup('review_mode: final');
    await writeFile(
      join(s.ctx.cwd, 'check.js'),
      "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1);\n",
    );
    s.ctx.config.dev.check_commands = ['node check.js'];
    const FAILING = 'final checks of the project failed';
    const inner = s.ctx.runner;
    s.ctx.runner = async (req) => {
      // the first Dev call passes the checks; a review fix breaks them; the check fix repairs them
      if (!req.prompt.includes('reviewer sent these items back'))
        await writeFile(join(s.ctx.cwd, 'fixed.txt'), 'x');
      if (req.prompt.includes('reviewer sent these items back'))
        await rm(join(s.ctx.cwd, 'fixed.txt'), { force: true });
      if (req.prompt.includes(FAILING))
        await writeFile(join(s.ctx.cwd, 'fixed.txt'), 'x');
      return inner(req);
    };
    let leads = 0;
    let reviewers = 0;
    const finding = {
      task: 'T1',
      title: 'Falta validar',
      description: 'sem validação',
      raised_by: ['A'],
      rationale: 'importa',
    };
    const makeRunner: RunnerFactory = () => async (req) => {
      if (req.prompt.includes('adversarial code reviewer')) {
        reviewers++;
        return '## Findings\n\nno findings';
      }
      return ++leads === 1
        ? JSON.stringify({
            verdict: 'rejected',
            act_on: [finding],
            consider: [],
            noted: [],
            dismissed: [],
          })
        : APPROVED;
    };
    await createBuildStage({ io: createFakeIO([]), makeRunner })(s.ctx);
    // cycle 1 (rejected), cycle 2 (approved), then one more review for the check fix
    expect(reviewers).toBe(3);
    const review = await readFile(join(s.ctx.run.dir, 'review.md'), 'utf-8');
    expect(review).toContain('## Correções dos checks finais');
  }, 60_000);
});
