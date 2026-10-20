import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runArena } from '../arena.js';
import { saveArtifact } from '../artifacts.js';
import type { IO } from '../io.js';
import type { StageFn } from '../orchestrator.js';
import type { RunnerFactory } from '../runner.js';
import {
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

/**
 * Dev and Review together (DESIGN 4.7): for each batch, the Dev (in arena by default),
 * then the review with its correction cycles, then one local commit once approved.
 * Never pushes. A batch already committed on the branch is skipped, so a resumed run
 * goes on where it stopped.
 */
export function createBuildStage(options: BuildOptions): StageFn {
  const { io, makeRunner } = options;
  const skill = options.skillsDir ? { skillsDir: options.skillsDir } : {};
  return async (ctx) => {
    const { list } = await gatherInputs(ctx, options.skillsDir);
    // The arena is on by default; a trivial task and `candidates: 1` run a plain Dev (3.2).
    const arena = ctx.config.dev.arena.candidates > 1 && ctx.size !== 'trivial';
    const branch = await ensureBranch(ctx.cwd, ctx.run);
    io.write(
      `Dev na branch ${branch}${arena ? ` (arena com ${ctx.config.dev.arena.candidates} candidatos)` : ''}.`,
    );

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
