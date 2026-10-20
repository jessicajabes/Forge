import type { Config } from './config.js';
import { readState, writeState } from './state.js';
import type { Run } from './runs.js';
import type { Runner } from './runner.js';
import type { ProgressReporter } from './progressReporter.js';

/**
 * The stages of DESIGN section 1, plus the human stop of 4.10 between Tasks and Dev.
 * `build` is Dev and Review together: the loop over batches of 4.7, where each batch
 * goes Dev, Review, correction cycles, and a local commit once approved.
 */
export const PIPELINE = [
  'grill',
  'recon',
  'tasks',
  'approve',
  'build',
  'lessons',
] as const;
export type StageName = (typeof PIPELINE)[number];

export type TaskSize = 'complete' | 'trivial';

export type RunContext = {
  /** The target repository. */
  cwd: string;
  /** The task, as typed after `forge-jj`. */
  task: string;
  size: TaskSize;
  run: Run;
  config: Config;
  runner: Runner;
  /** Where the stage lines go. Absent: the stages run without progress output. */
  reporter?: ProgressReporter;
};

export type StageFn = (ctx: RunContext) => Promise<void>;
export type Stages = Record<StageName, StageFn>;

/** Thrown by a stage (for example the human stop) to end the run on purpose. */
export class RunCancelled extends Error {
  constructor(message = 'execução cancelada') {
    super(message);
    this.name = 'RunCancelled';
  }
}

export type RunResult = {
  status: 'completed' | 'cancelled';
  /** Stages that ran to the end during this call, in order. */
  stagesRun: StageName[];
};

/**
 * Runs the pipeline in order. A trivial task skips the Grill: its minimal spec is
 * written by the Tasks stage (DESIGN 3.2). Each stage reads the previous artifacts
 * from the run folder, never the conversation (4.1).
 *
 * Progress is saved in the run folder after every stage. Calling it again on the same
 * run folder resumes: stages that already completed are not repeated (3.3).
 *
 * With a reporter, each stage gets an entry line with its position and an exit line with
 * its duration. Skipped stages (the Grill of a trivial task) are not counted.
 */
export async function runWorkflow(
  ctx: RunContext,
  stages: Stages,
): Promise<RunResult> {
  const previous = await readState(ctx.run.dir);
  const completed = new Set(
    previous?.status === 'running' ? previous.completed : [],
  );
  const stagesRun: StageName[] = [];
  const save = (status: 'running' | 'completed' | 'cancelled') =>
    writeState(ctx.run.dir, {
      task: ctx.task,
      slug: ctx.run.slug,
      size: ctx.size,
      completed: [...completed],
      status,
    });

  await save('running');
  const planned = PIPELINE.filter(
    (name) => !(name === 'grill' && ctx.size === 'trivial'),
  );
  for (const [position, name] of planned.entries()) {
    if (completed.has(name)) continue;
    const stage = { stage: name, index: position + 1, total: planned.length };
    const started = Date.now();
    const reportEnd = () =>
      ctx.reporter?.report({
        type: 'stage',
        phase: 'end',
        ...stage,
        ms: Date.now() - started,
      });
    await ctx.reporter?.report({ type: 'stage', phase: 'start', ...stage });
    try {
      await stages[name](ctx);
    } catch (error) {
      await reportEnd();
      if (error instanceof RunCancelled) {
        await save('cancelled');
        return { status: 'cancelled', stagesRun };
      }
      throw error;
    }
    await reportEnd();
    completed.add(name);
    stagesRun.push(name);
    await save('running');
  }
  await save('completed');
  return { status: 'completed', stagesRun };
}
