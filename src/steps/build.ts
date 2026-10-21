import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runArena } from '../arena.js';
import { resolveArenaMode } from '../arenaMode.js';
import { saveArtifact, type Task } from '../artifacts.js';
import { devBatching } from '../config.js';
import { commitAll, headHash } from '../git.js';
import type { IO } from '../io.js';
import type { RunContext, StageFn } from '../orchestrator.js';
import type { RunnerFactory } from '../runner.js';
import {
  type Batch,
  commitBatch,
  committedBatches,
  ensureBranch,
  gatherInputs,
  runDevBatch,
  splitBatches,
} from './dev.js';
import { reviewBatch } from './review.js';

export type BuildOptions = {
  io: IO;
  /** One runner per directory: candidates in worktrees, reviewers and the lead read-only. */
  makeRunner: RunnerFactory;
  skillsDir?: string;
};

/** Progress of a Dev per task with one final review, kept in the run folder (DESIGN 4.7). */
type BuildState = {
  /** `HEAD` before the first task: the final review reads the diff against it. */
  base: string;
  /** Tasks that finished without any change to commit, so no commit marks them. */
  completed: number[];
  reviewed: boolean;
};

async function readState(path: string): Promise<BuildState | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as BuildState;
  } catch {
    return null;
  }
}

const saveState = (path: string, state: BuildState) =>
  saveArtifact(path, JSON.stringify(state, null, 2), () => undefined);

/**
 * Dev and Review together (DESIGN 4.7): for each batch, the Dev (in arena only when opted in),
 * then the review with its correction cycles, then one local commit once approved.
 * Never pushes. A batch already committed on the branch is skipped, so a resumed run
 * goes on where it stopped.
 */
export function createBuildStage(options: BuildOptions): StageFn {
  const { io, makeRunner } = options;
  const skill = options.skillsDir ? { skillsDir: options.skillsDir } : {};

  /**
   * `dev.batching: per_task` with `review_mode: final`: one Dev call (or arena) per task,
   * each committed as soon as it ends so the next one starts from it, then one review of
   * everything against the commit before the first task. A failed task stops the run;
   * running again goes on from it.
   */
  async function buildPerTaskThenReview(
    ctx: RunContext,
    tasks: Task[],
    arena: boolean,
  ): Promise<void> {
    const statePath = join(ctx.run.dir, 'build.json');
    const state: BuildState = (await readState(statePath)) ?? {
      base: await headHash(ctx.cwd),
      completed: [],
      reviewed: false,
    };
    await saveState(statePath, state);

    const batches = splitBatches(tasks, 'per_task');
    const done = await committedBatches(ctx.cwd, ctx.run);
    for (const batch of batches) {
      if (done.has(batch.index) || state.completed.includes(batch.index))
        continue;
      if (arena) await runArena(ctx, batch, { makeRunner, io, ...skill });
      else await runDevBatch(ctx, batch, skill);
      const hash = await commitBatch(ctx, batch);
      if (hash === null) {
        state.completed.push(batch.index);
        await saveState(statePath, state);
      }
      io.write(
        hash === null
          ? `Tarefa ${batch.index} de ${batch.total}: sem mudanças para commitar.`
          : `Tarefa ${batch.index} de ${batch.total} commitada (${hash.slice(0, 7)}).`,
      );
    }

    if (!state.reviewed) {
      const whole: Batch = { index: 1, total: 1, tasks };
      let fixes = 0;
      const { cycles, leftover } = await reviewBatch(
        ctx,
        whole,
        { makeRunner, io, ...skill },
        (feedback, taskIds) =>
          runDevBatch(
            ctx,
            {
              index: 1,
              total: 1,
              tasks: tasks.filter((t) => taskIds.includes(t.id)),
            },
            { ...skill, feedback, reportName: `dev-fix-${++fixes}.md` },
          ),
        { base: state.base, groupByTask: true },
      );
      const hash = await commitAll(ctx.cwd, 'forge: correções da revisão', [
        `Forge-Run: ${ctx.run.id}`,
        'Forge-Batch: review',
      ]);
      state.reviewed = true;
      await saveState(statePath, state);
      io.write(
        hash === null
          ? `Revisão final aprovada em ${cycles} ciclo(s), sem correções para commitar.`
          : `Revisão final aprovada em ${cycles} ciclo(s) e correções commitadas (${hash.slice(0, 7)}).`,
      );
      if (leftover.length > 0) {
        io.write(
          `Revisão final: ${leftover.length} item(ns) consider ficaram em aberto no limite de ciclos e estão anotados no review.`,
        );
      }
    }
    await writeReview(ctx.run.dir, 1);
  }

  return async (ctx) => {
    const { list } = await gatherInputs(ctx, options.skillsDir);
    const arena = resolveArenaMode(ctx.config, ctx.size).enabled;
    const branch = await ensureBranch(ctx.cwd, ctx.run);
    io.write(
      `Dev na branch ${branch}${arena ? ` (arena com ${ctx.config.dev.arena.candidates} candidatos)` : ''}.`,
    );

    if (
      ctx.config.review_mode === 'final' &&
      devBatching(ctx.config) === 'per_task'
    ) {
      await buildPerTaskThenReview(ctx, list.tasks, arena);
      return;
    }

    const batches = splitBatches(list.tasks, ctx.config.review_mode);
    const done = await committedBatches(ctx.cwd, ctx.run);
    for (const batch of batches) {
      if (done.has(batch.index)) continue;
      if (arena) await runArena(ctx, batch, { makeRunner, io, ...skill });
      else await runDevBatch(ctx, batch, skill);

      const { cycles, leftover } = await reviewBatch(
        ctx,
        batch,
        { makeRunner, io, ...skill },
        (feedback) => runDevBatch(ctx, batch, { ...skill, feedback }),
      );
      const hash = await commitBatch(ctx, batch);
      io.write(
        hash === null
          ? `Lote ${batch.index}: aprovado em ${cycles} ciclo(s), mas sem mudanças para commitar.`
          : `Lote ${batch.index} aprovado em ${cycles} ciclo(s) e commitado (${hash.slice(0, 7)}).`,
      );
      if (leftover.length > 0) {
        io.write(
          `Lote ${batch.index}: ${leftover.length} item(ns) consider ficaram em aberto no limite de ciclos e estão anotados no review.`,
        );
      }
    }
    await writeReview(ctx.run.dir, batches.length);
  };
}

/** `review.md`: the single batch as is, or every batch under its own heading. */
async function writeReview(runDir: string, total: number): Promise<void> {
  const parts: string[] = [];
  for (let i = 1; i <= total; i++) {
    try {
      parts.push(await readFile(join(runDir, `review-batch-${i}.md`), 'utf-8'));
    } catch {
      // a batch with no review file (already committed in an earlier attempt)
    }
  }
  const text =
    total === 1 && parts[0]
      ? parts[0]
      : `# Revisão\n\n${parts.map((p, i) => `## Lote ${i + 1} de ${total}\n\n${p.replace(/^# Revisão\n+/, '').replace(/^(#+) /gm, '#$1 ')}`).join('\n')}`;
  await saveArtifact(join(runDir, 'review.md'), text, () => undefined);
}
