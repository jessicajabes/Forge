import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runArena, runChecks } from '../arena.js';
import { resolveArenaMode } from '../arenaMode.js';
import { saveArtifact, type Task } from '../artifacts.js';
import { writeDevTaskDocs } from '../taskDocs.js';
import { devBatching } from '../config.js';
import { commitAll, headHash, isClean, workingDiff } from '../git.js';
import type { IO } from '../io.js';
import type { RunContext, StageFn } from '../orchestrator.js';
import type { RunnerFactory } from '../runner.js';
import {
  type Batch,
  commitBatch,
  commitSubject,
  committedBatches,
  ensureBranch,
  gatherInputs,
  runDevBatch,
  splitBatches,
} from './dev.js';
import { reviewBatch } from './review.js';

/** How many times the Dev may fix a failing final check before the run stops. */
const FINAL_CHECK_FIXES = 2;

export type BuildOptions = {
  io: IO;
  /** One runner per directory: candidates in worktrees, reviewers and the lead read-only. */
  makeRunner: RunnerFactory;
  skillsDir?: string;
};

/**
 * Progress of the build, kept in the run folder (DESIGN 4.7). It says which phase of which
 * batch already ended, so a resumed run does not redo a Dev, an arena or a review.
 */
type BuildState = {
  /** `HEAD` before the first task: the final review reads the diff against it. */
  base: string;
  /** Tasks that finished without any change to commit, so no commit marks them. */
  completed: number[];
  reviewed: boolean;
  /** Batches whose Dev (or arena) ended. Its changes are in the working tree, not committed yet. */
  devDone: number[];
  /** Batches whose review ended approved. */
  reviewedBatches: number[];
  /** The project checks passed before the review (Dev once, then review). */
  checked: boolean;
};

async function readState(path: string): Promise<BuildState | null> {
  try {
    const raw = JSON.parse(
      await readFile(path, 'utf-8'),
    ) as Partial<BuildState>;
    return {
      base: raw.base ?? '',
      completed: raw.completed ?? [],
      reviewed: raw.reviewed ?? false,
      devDone: raw.devDone ?? [],
      reviewedBatches: raw.reviewedBatches ?? [],
      checked: raw.checked ?? false,
    };
  } catch {
    return null;
  }
}

const saveState = (path: string, state: BuildState) =>
  saveArtifact(path, JSON.stringify(state, null, 2), () => undefined);

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function loadBuildState(ctx: RunContext) {
  const path = join(ctx.run.dir, 'build.json');
  const state: BuildState = (await readState(path)) ?? {
    base: await headHash(ctx.cwd),
    completed: [],
    reviewed: false,
    devDone: [],
    reviewedBatches: [],
    checked: false,
  };
  await saveState(path, state);
  return { path, state };
}

/**
 * Did the Dev (or the arena) of this batch already end in an earlier attempt? Its changes are
 * still in the working tree. Runs saved before `build.json` tracked the phases are recognized by
 * the report the Dev or the arena left in the run folder.
 */
async function devAlreadyDone(
  ctx: RunContext,
  batch: Batch,
  state: BuildState,
): Promise<boolean> {
  if (state.devDone.includes(batch.index)) return true;
  if (await isClean(ctx.cwd)) return false;
  return (
    (await exists(join(ctx.run.dir, `dev-lote-${batch.index}.md`))) ||
    (await exists(join(ctx.run.dir, 'arena', String(batch.index), 'arena.md')))
  );
}

/** Did the review of this batch already end approved? Its report says so. */
async function reviewAlreadyDone(
  ctx: RunContext,
  batch: Batch,
  state: BuildState,
): Promise<boolean> {
  if (state.reviewedBatches.includes(batch.index)) return true;
  try {
    return /\*\*Veredito\*\*: aprovado/.test(
      await readFile(
        join(ctx.run.dir, `review-lote-${batch.index}.md`),
        'utf-8',
      ),
    );
  } catch {
    return false;
  }
}

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
    const { path: statePath, state } = await loadBuildState(ctx);

    const batches = splitBatches(tasks, 'per_task');
    const done = await committedBatches(ctx.cwd, ctx.run);
    for (const batch of batches) {
      if (done.has(batch.index) || state.completed.includes(batch.index))
        continue;
      if (await devAlreadyDone(ctx, batch, state)) {
        io.write(
          `Tarefa ${batch.index} de ${batch.total}: o Dev já tinha terminado, sem refazer.`,
        );
      } else {
        await runDev(ctx, batch, arena);
        state.devDone.push(batch.index);
        await saveState(statePath, state);
      }
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
            { ...skill, feedback, reportName: `dev-correcao-${++fixes}.md` },
          ),
        { base: state.base, groupByTask: true },
      );
      const hash = await commitAll(
        ctx.cwd,
        await commitSubject(ctx.cwd, 'correções da revisão'),
        [`Forge-Run: ${ctx.run.id}`, 'Forge-Batch: review'],
      );
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

  /** The Dev of one batch: the arena when opted in, else one plain call. Files the report under each task. */
  async function runDev(
    ctx: RunContext,
    batch: Batch,
    arena: boolean,
  ): Promise<void> {
    if (!arena) {
      await runDevBatch(ctx, batch, skill);
      return;
    }
    const { note } = await runArena(ctx, batch, { makeRunner, io, ...skill });
    await writeDevTaskDocs(
      ctx.run.dir,
      batch.tasks,
      note,
      `arena/${batch.index}/arena.md`,
    );
  }

  /**
   * The project's own checks (`dev.check_commands`: lint, prettier, the full suite), once, after
   * the last review fix. A failure goes back to the Dev, up to `FINAL_CHECK_FIXES` times; if it
   * still fails the run stops for a person, with the failing commands in the error.
   * Whatever is left uncommitted when the checks pass (the Dev's fixes, or a person's edits on a
   * resumed run) goes through a short review against `HEAD` before it is committed.
   */
  async function runFinalChecks(
    ctx: RunContext,
    tasks: Task[],
    /** `false`: only make the checks pass (before the review); the review and the commit come later. */
    finish = true,
  ): Promise<void> {
    const commands = ctx.config.dev.check_commands;
    if (commands.length === 0) return;
    let reviewed = false;
    for (let fix = 0; ;) {
      const results = await runChecks(ctx.cwd, commands, ctx.reporter);
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        io.write('Checks finais passaram.');
        if (!finish) return;
        if (!reviewed && !(await isClean(ctx.cwd))) {
          const before = await workingDiff(ctx.cwd);
          await reviewCheckFixes(ctx, tasks);
          reviewed = true;
          // the review edited code: the checks run again
          if ((await workingDiff(ctx.cwd)) !== before) continue;
        }
        // Also on a resumed run: edits an earlier stop left uncommitted are committed here
        await commitAll(
          ctx.cwd,
          await commitSubject(ctx.cwd, 'correções dos checks finais'),
          [`Forge-Run: ${ctx.run.id}`, 'Forge-Batch: checks'],
        );
        return;
      }
      const summary = failed.map((c) => `- \`${c.command}\`: ${c.detail}`);
      if (fix === FINAL_CHECK_FIXES) {
        throw new Error(
          `os checks finais ainda falham depois de ${FINAL_CHECK_FIXES} correção(ões) do Dev:\n${summary.join('\n')}`,
        );
      }
      io.write(
        `Checks finais falharam (${failed.length}). Devolvendo ao Dev (${fix + 1} de ${FINAL_CHECK_FIXES}).`,
      );
      const allowed = ctx.config.dev.allowed_commands;
      const blocked = failed
        .map((c) => c.command)
        .filter((c) => !allowed.some((a) => c === a || c.startsWith(`${a} `)));
      const blockedNote =
        blocked.length > 0
          ? `\n\nThese failing commands are NOT in your allowed commands, so you cannot run them to see the error; reason from the code and say so in the report:\n${blocked.map((c) => `- \`${c}\``).join('\n')}`
          : '';
      reviewed = false;
      fix++;
      await runDevBatch(
        ctx,
        { index: 1, total: 1, tasks },
        {
          ...skill,
          feedback: `The final checks of the project failed. Only the exit code is shown below, not the error output. Run each failing command yourself, if it is in your allowed commands, to see the error; if it is not allowed, say so in the report. Fix the cause in the code, and do not change the checks.\n\n${summary.join('\n')}${blockedNote}`,
          reportName: `dev-checks-${fix}.md`,
        },
      );
    }
  }

  /** The uncommitted changes left by the final checks, reviewed like a batch and appended to `review.md`. */
  async function reviewCheckFixes(
    ctx: RunContext,
    tasks: Task[],
  ): Promise<void> {
    const batch: Batch = { index: 0, total: 1, tasks };
    let fixes = 0;
    const { cycles, reviewPath } = await reviewBatch(
      ctx,
      batch,
      { makeRunner, io, ...skill },
      (feedback) =>
        runDevBatch(ctx, batch, {
          ...skill,
          feedback,
          reportName: `dev-checks-revisao-${++fixes}.md`,
        }),
    );
    io.write(`Correções dos checks finais revisadas em ${cycles} ciclo(s).`);
    const reviewFile = join(ctx.run.dir, 'review.md');
    const body = (await readFile(reviewPath, 'utf-8'))
      .replace(/^# Revisão\n+/, '')
      .replace(/^(#+) /gm, '#$1 ');
    let current = '';
    try {
      current = await readFile(reviewFile, 'utf-8');
    } catch {
      // no review.md yet
    }
    await saveArtifact(
      reviewFile,
      `${current.trimEnd()}\n\n## Correções dos checks finais\n\n${body}`,
      () => undefined,
    );
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
      await runFinalChecks(ctx, list.tasks);
      return;
    }

    // One batch with every task (`review_mode: final`): the Dev does all the tasks in one
    // context, the project checks run, and only then does the review. Several batches
    // (`per_task`): each one goes Dev, review, commit, and the checks run once at the end.
    const batches = splitBatches(list.tasks, ctx.config.review_mode);
    const single = batches.length === 1 && ctx.config.review_mode === 'final';
    const { path: statePath, state } = await loadBuildState(ctx);
    const done = await committedBatches(ctx.cwd, ctx.run);
    for (const batch of batches) {
      if (done.has(batch.index)) continue;
      if (await devAlreadyDone(ctx, batch, state)) {
        io.write(`Lote ${batch.index}: o Dev já tinha terminado, sem refazer.`);
      } else {
        await runDev(ctx, batch, arena);
        state.devDone.push(batch.index);
        await saveState(statePath, state);
      }

      if (single && !state.checked) {
        await runFinalChecks(ctx, list.tasks, false);
        state.checked = true;
        await saveState(statePath, state);
      }

      let cycles = 0;
      let leftover: unknown[] = [];
      if (await reviewAlreadyDone(ctx, batch, state)) {
        io.write(
          `Lote ${batch.index}: a revisão já tinha sido aprovada, sem refazer.`,
        );
      } else {
        let fixes = 0;
        ({ cycles, leftover } = await reviewBatch(
          ctx,
          batch,
          { makeRunner, io, ...skill },
          (feedback) =>
            runDevBatch(ctx, batch, {
              ...skill,
              feedback,
              reportName: `dev-correcao-${batch.index}-${++fixes}.md`,
            }),
        ));
        state.reviewedBatches.push(batch.index);
        await saveState(statePath, state);
        // the review changed code: the checks run again before the commit
        if (single && cycles > 1) {
          const before = await workingDiff(ctx.cwd);
          await runFinalChecks(ctx, list.tasks, false);
          // a check failed and the Dev fixed it: that fix is reviewed too
          if ((await workingDiff(ctx.cwd)) !== before) {
            await reviewCheckFixes(ctx, list.tasks);
            await runFinalChecks(ctx, list.tasks, false);
          }
        }
      }

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
    if (!single) await runFinalChecks(ctx, list.tasks);
  };
}

/** `review.md`: the single batch as is, or every batch under its own heading. */
async function writeReview(runDir: string, total: number): Promise<void> {
  const parts: string[] = [];
  for (let i = 1; i <= total; i++) {
    try {
      parts.push(await readFile(join(runDir, `review-lote-${i}.md`), 'utf-8'));
    } catch {
      // a batch with no review file (already committed in an earlier attempt)
    }
  }
  const text =
    total === 1 && parts[0]
      ? parts[0]
      : `# Revisão\n\n${parts.map((p, i) => `## Lote ${i + 1} de ${total}\n\n${p.replace(/^# Revisão\n+/, '').replace(/^(#+) /gm, '#$1 ')}`).join('\n')}`;
  // keep the section a review of check fixes already appended
  const previous = await readFile(join(runDir, 'review.md'), 'utf-8').catch(
    () => '',
  );
  const extra = /\n## Correções dos checks finais[\s\S]*$/.exec(previous)?.[0];
  await saveArtifact(
    join(runDir, 'review.md'),
    extra && !text.includes(extra) ? `${text.trimEnd()}\n${extra}` : text,
    () => undefined,
  );
}
