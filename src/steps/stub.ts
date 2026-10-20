import { join } from 'node:path';
import { parseSpec, parseTasks, saveArtifact } from '../artifacts.js';
import { workflowDir } from '../runs.js';
import type { RunContext, StageFn, Stages } from '../orchestrator.js';

/**
 * Placeholder stages that only prove the plumbing: each one calls the runner once
 * and saves what came back. They are replaced one by one by the real stages.
 */
function stage(
  name: string,
  opts: {
    canEdit?: boolean;
    artifact?: (ctx: RunContext) => {
      path: string;
      validate?: (text: string) => unknown;
    };
  } = {},
): StageFn {
  return async (ctx) => {
    const text = await ctx.runner({
      prompt: `stage:${name}\n${ctx.task}`,
      files: [],
      canEdit: opts.canEdit ?? false,
    });
    const target = opts.artifact?.(ctx);
    if (target)
      await saveArtifact(
        target.path,
        text,
        target.validate ?? (() => undefined),
      );
  };
}

export function stubStages(): Stages {
  const inRun = (ctx: RunContext, file: string) => join(ctx.run.dir, file);
  return {
    grill: stage('grill', {
      artifact: (ctx) => ({ path: inRun(ctx, 'spec.md'), validate: parseSpec }),
    }),
    recon: stage('recon', {
      artifact: (ctx) => ({ path: inRun(ctx, 'context.md') }),
    }),
    tasks: stage('tasks', {
      artifact: (ctx) => ({
        path: inRun(ctx, 'tasks.md'),
        validate: parseTasks,
      }),
    }),
    approve: async () => undefined,
    build: async (ctx) => {
      await stage('dev', { canEdit: true })(ctx);
      await stage('review', {
        artifact: (c) => ({ path: inRun(c, 'review.md') }),
      })(ctx);
    },
    lessons: stage('lessons', {
      artifact: (ctx) => ({ path: join(workflowDir(ctx.cwd), 'lessons.md') }),
    }),
  };
}
