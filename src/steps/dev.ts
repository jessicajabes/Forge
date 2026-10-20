import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTasks, type Task } from '../artifacts.js';
import {
  branchExists,
  checkout,
  commitAll,
  currentBranch,
  git,
} from '../git.js';
import type { RunContext } from '../orchestrator.js';
import { workflowDir, type Run } from '../runs.js';
import { loadSkill } from '../skills.js';
import { saveArtifact } from '../artifacts.js';

export type Batch = { index: number; total: number; tasks: Task[] };

/** `review_mode: final` is one batch with every task; `per_task` is one batch per task (DESIGN 4.7). */
export function splitBatches(
  tasks: Task[],
  mode: 'final' | 'per_task',
): Batch[] {
  const groups = mode === 'per_task' ? tasks.map((t) => [t]) : [tasks];
  return groups.map((group, i) => ({
    index: i + 1,
    total: groups.length,
    tasks: group,
  }));
}

/** The Markdown block of each task, keyed by number, taken from tasks.md as written. */
export function taskBlocks(markdown: string): Map<number, string> {
  const blocks = new Map<number, string>();
  const parts = markdown.split(/^(?=##\s+T\d+:)/m);
  for (const part of parts) {
    const m = /^##\s+T(\d+):/.exec(part);
    if (m)
      blocks.set(
        Number(m[1]),
        part.replace(/\n##\s+Dúvidas[\s\S]*$/, '').trimEnd(),
      );
  }
  return blocks;
}

/**
 * Makes sure the Dev works on its own branch `forge/<slug>` (DESIGN 4.6). A branch that
 * already holds commits of this run is reused (a resumed run); a name taken by another
 * run gets the run id instead.
 */
export async function ensureBranch(cwd: string, run: Run): Promise<string> {
  const wanted = `forge/${run.slug}`;
  const current = await currentBranch(cwd);
  if (current?.startsWith('forge/')) return current;
  if (!(await branchExists(cwd, wanted))) {
    await checkout(cwd, wanted, true);
    return wanted;
  }
  const log = await git(cwd, ['log', '--format=%B', wanted]).catch(() => '');
  if (log.includes(`Forge-Run: ${run.id}`)) {
    await checkout(cwd, wanted);
    return wanted;
  }
  const alternative = `forge/${run.id}`;
  await checkout(cwd, alternative, true);
  return alternative;
}

/** Batch numbers already committed on this branch, read from the `Forge-Batch` trailers. */
export async function committedBatches(
  cwd: string,
  run: Run,
): Promise<Set<number>> {
  const log = await git(cwd, ['log', '--format=%B%x00']).catch(() => '');
  const done = new Set<number>();
  for (const message of log.split('\0')) {
    if (!message.includes(`Forge-Run: ${run.id}`)) continue;
    const m = /Forge-Batch:\s*(\d+)/.exec(message);
    if (m) done.add(Number(m[1]));
  }
  return done;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export type DevInputs = {
  skillBody: string;
  spec: string;
  context: string;
  lessons: string | null;
  tasksPath: string;
  allowedCommands: string[];
  batchMarkdown: string;
  batch: Batch;
  /** Items the reviewer sent back, when this is a correction cycle. */
  feedback?: string;
};

export function buildDevPrompt(i: DevInputs): string {
  return `${i.skillBody}

---

# Forge inputs

## Batch ${i.batch.index} of ${i.batch.total}

Implement only these tasks, in order.

${i.batchMarkdown}

The tasks file, where you mark the boxes of a finished task: ${i.tasksPath}

## Shell commands you may run

${i.allowedCommands.length > 0 ? i.allowedCommands.map((c) => `- ${c}`).join('\n') : '(none)'}

## spec.md

${i.spec}

## context.md

${i.context}
${i.lessons?.trim() ? `\n## lessons.md\n\n${i.lessons}\n` : ''}${
    i.feedback
      ? `\n## The reviewer sent these items back. Fix them.\n\n${i.feedback}\n`
      : ''
  }`;
}

export async function gatherInputs(ctx: RunContext, skillsDir?: string) {
  const skill = await loadSkill('dev', skillsDir);
  const tasksPath = join(ctx.run.dir, 'tasks.md');
  const tasksMarkdown = await readFile(tasksPath, 'utf-8');
  return {
    skillBody: skill.body,
    spec: (await readOptional(join(ctx.run.dir, 'spec.md'))) ?? '(no spec)',
    context:
      (await readOptional(join(ctx.run.dir, 'context.md'))) ??
      '(no project context available)',
    lessons: await readOptional(join(workflowDir(ctx.cwd), 'lessons.md')),
    tasksPath,
    tasksMarkdown,
    list: parseTasks(tasksMarkdown),
    blocks: taskBlocks(tasksMarkdown),
  };
}

/**
 * One plain Dev run on one batch (an editing call to the runner). The changes are left
 * in the working tree; the report goes to the run folder. Returns the report text.
 */
export async function runDevBatch(
  ctx: RunContext,
  batch: Batch,
  opts: { skillsDir?: string; feedback?: string; reportName?: string } = {},
): Promise<string> {
  const inputs = await gatherInputs(ctx, opts.skillsDir);
  const batchMarkdown = batch.tasks
    .map((t) => inputs.blocks.get(t.id) ?? `## T${t.id}: ${t.title}`)
    .join('\n\n');
  const prompt = buildDevPrompt({
    skillBody: inputs.skillBody,
    spec: inputs.spec,
    context: inputs.context,
    lessons: inputs.lessons,
    tasksPath: inputs.tasksPath,
    allowedCommands: ctx.config.dev.allowed_commands,
    batchMarkdown,
    batch,
    ...(opts.feedback ? { feedback: opts.feedback } : {}),
  });
  const report = await ctx.runner({ prompt, files: [], canEdit: true });
  await saveArtifact(
    join(ctx.run.dir, opts.reportName ?? `dev-batch-${batch.index}.md`),
    report,
    () => undefined,
  );
  return report;
}

/** Commits a batch locally with the run and batch recorded as trailers. Null if nothing changed. */
export async function commitBatch(
  ctx: RunContext,
  batch: Batch,
): Promise<string | null> {
  const ids = batch.tasks.map((t) => `T${t.id}`).join(', ');
  const titles = batch.tasks.map((t) => t.title).join('; ');
  const subject = `forge: ${ids} - ${titles}`.slice(0, 100);
  return commitAll(ctx.cwd, subject, [
    `Forge-Run: ${ctx.run.id}`,
    `Forge-Batch: ${batch.index}`,
    `Forge-Tasks: ${ids}`,
  ]);
}
