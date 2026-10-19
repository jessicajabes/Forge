import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSpec, parseTasks, saveArtifact } from '../artifacts.js';
import type { RunContext, StageFn } from '../orchestrator.js';
import { workflowDir } from '../runs.js';
import { loadSkill } from '../skills.js';
import { assertAllOk, runSubagents } from '../subagents.js';

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function ask(
  ctx: RunContext,
  id: string,
  prompt: string,
  validate: (t: string) => unknown,
): Promise<string> {
  const [result] = await runSubagents(ctx.runner, [{ id, prompt, validate }], {
    maxParallel: 1,
  });
  const [ok] = assertAllOk(result ? [result] : []);
  return ok?.text ?? '';
}

/** A trivial spec has no interview behind it, so every decision is a guess. */
function validateProvisionalSpec(text: string): void {
  const spec = parseSpec(text);
  const firm = spec.decisions.filter((d) => !d.provisional);
  if (firm.length > 0) {
    throw new Error(
      'toda decisão do spec mínimo deve terminar com (provisória)',
    );
  }
}

/**
 * On a trivial task there was no Grill: one read-only call writes a minimal spec from
 * the command text and `context.md`, with everything marked (provisória) (DESIGN 3.2).
 */
async function writeMinimalSpec(
  ctx: RunContext,
  context: string,
): Promise<string> {
  const prompt = `You are the spec writer of the Forge. The user skipped the interview because the task is trivial, so you write a minimal spec from the task text and the project context. You have read-only access to the repository. Write in the language the task is written in.

## Task

${ctx.task}

## Project context

${context}

## Now

Reply with the Markdown of spec.md and nothing else, using exactly this structure:

# Spec: <title>

## Objetivo
## Decisões
## Fora do escopo
## Restrições
## Pontos em aberto

Rules:
- "Objetivo" restates the task in one or two sentences.
- "Restrições" comes from the project context (patterns to follow, what must not break).
- Every bullet in "Decisões" ends with (provisória), because nobody confirmed it.
- If a section has nothing, write "- nenhum" or "- nenhuma". Keep the section names and bullets in Portuguese.
`;
  const spec = await ask(ctx, 'minimal-spec', prompt, validateProvisionalSpec);
  await saveArtifact(
    join(ctx.run.dir, 'spec.md'),
    spec,
    validateProvisionalSpec,
  );
  return spec;
}

export type TasksOptions = { skillsDir?: string };

/** Writes `tasks.md` with the `tasks` skill, from spec.md, context.md and lessons.md. */
export function createTasksStage(options: TasksOptions = {}): StageFn {
  return async (ctx) => {
    const skill = await loadSkill('tasks', options.skillsDir);
    const context =
      (await readOptional(join(ctx.run.dir, 'context.md'))) ??
      '(no project context available)';
    let spec = await readOptional(join(ctx.run.dir, 'spec.md'));
    if (spec === null) spec = await writeMinimalSpec(ctx, context);
    const lessons = await readOptional(
      join(workflowDir(ctx.cwd), 'lessons.md'),
    );

    const prompt = `${skill.body}

---

# Forge inputs

## spec.md

${spec}

## context.md

${context}
${lessons?.trim() ? `\n## lessons.md\n\n${lessons}\n` : ''}
Reply with the contents of tasks.md and nothing else.
`;
    const tasks = await ask(ctx, 'tasks', prompt, parseTasks);
    await saveArtifact(join(ctx.run.dir, 'tasks.md'), tasks, parseTasks);
  };
}
