import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { saveArtifact } from './artifacts.js';
import {
  addWorktree,
  applyPatchFile,
  removeWorktree,
  workingDiff,
} from './git.js';
import type { IO } from './io.js';
import type { RunContext } from './orchestrator.js';
import type { RunnerFactory } from './runner.js';
import { loadReference, loadSkill } from './skills.js';
import { assertAllOk, mapLimit, runSubagents } from './subagents.js';
import { buildDevPrompt, gatherInputs, type Batch } from './steps/dev.js';

const execFileAsync = promisify(execFile);

/** The Forge stops and shows the human what happened (DESIGN 4.14, edge cases). */
export class ArenaEscalation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArenaEscalation';
  }
}

export type ArenaDeps = {
  makeRunner: RunnerFactory;
  io: IO;
  skillsDir?: string;
};

type Candidate = {
  index: number;
  dir: string;
  model: string | undefined;
  report: string;
  diff: string;
};
type Dropout = { index: number; reason: string };

const verdictSchema = z.object({
  scores: z.array(
    z.object({
      candidate: z.number().int(),
      criteria: z.array(
        z.object({
          criterion: z.string(),
          score: z.number(),
          note: z.string(),
        }),
      ),
    }),
  ),
  base: z.number().int().nullable(),
  convergence: z.boolean().default(false),
  rationale: z.string(),
});
export type Verdict = z.infer<typeof verdictSchema>;

function parseVerdict(text: string): Verdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start)
    throw new Error('a resposta do juiz não tem JSON');
  return verdictSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

/** The arena gives candidates the project's allowed commands, never git worktree or push (DESIGN 4.6). */
export function safeCommands(commands: string[]): string[] {
  return commands.filter((c) => !/^\s*git\s+(worktree|push)\b/.test(c));
}

const MAX_DIFF_CHARS = 60_000;
const clip = (diff: string) =>
  diff.length > MAX_DIFF_CHARS
    ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... (diff cut; read the worktree for the rest)`
    : diff;

function renderCandidates(candidates: Candidate[]): string {
  return candidates
    .map(
      (c) =>
        `### Candidate ${c.index}${c.model ? ` (model ${c.model})` : ''}\nWorktree: ${c.dir}\n\nReport:\n${c.report}\n\nDiff:\n\`\`\`diff\n${clip(c.diff)}\n\`\`\``,
    )
    .join('\n\n');
}

/** Runs the project's checks on the result. The outcome is recorded, not a gate: Review decides. */
export async function runChecks(
  cwd: string,
  commands: string[],
): Promise<{ command: string; ok: boolean; detail: string }[]> {
  const results = [];
  for (const command of commands) {
    const [cmd, ...args] = command.trim().split(/\s+/);
    if (!cmd) continue;
    try {
      const running = execFileAsync(cmd, args, {
        cwd,
        timeout: 10 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      // A command that reads stdin (`prettier` with no files) would wait for it until the timeout
      running.child.stdin?.end();
      await running;
      results.push({ command, ok: true, detail: 'passou' });
    } catch (error) {
      const e = error as { code?: number | string; stderr?: string };
      results.push({
        command,
        ok: false,
        detail: `falhou (código ${e.code ?? '?'})`,
      });
    }
  }
  return results;
}

/**
 * The arena of DESIGN 4.14 for one batch: rubric, N candidates in git worktrees, a
 * read-only judge, then one integrator that edits the real project. On return the
 * integrated changes are in the working tree of `ctx.cwd`, uncommitted. Worktrees
 * are always removed.
 */
export async function runArena(
  ctx: RunContext,
  batch: Batch,
  deps: ArenaDeps,
): Promise<{ note: string }> {
  const { io } = deps;
  const arenaDir = join(ctx.run.dir, 'arena', String(batch.index));
  await mkdir(arenaDir, { recursive: true });
  const cfg = ctx.config.dev.arena;
  const inputs = await gatherInputs(ctx, deps.skillsDir);
  const devSkill = await loadSkill('dev', deps.skillsDir);
  const batchMarkdown = batch.tasks
    .map((t) => inputs.blocks.get(t.id) ?? `## T${t.id}: ${t.title}`)
    .join('\n\n');
  const allowed = safeCommands(ctx.config.dev.allowed_commands);
  const worktrees: string[] = [];
  // Idempotent: it runs before the checks and again in `finally`, which also covers failures
  const removeWorktrees = async () => {
    for (const dir of worktrees.splice(0)) {
      await removeWorktree(ctx.cwd, dir);
      await rm(dir, { recursive: true, force: true });
    }
  };

  try {
    // 1. Rubric: derived before any candidate starts, never shown to them.
    const rubricTemplate = await loadReference(
      'dev',
      'rubric-prompt',
      deps.skillsDir,
    );
    const [rubricResult] = await runSubagents(
      ctx.runner,
      [
        {
          id: 'rubric',
          prompt: rubricTemplate
            .replace('{SPEC}', inputs.spec)
            .replace('{TASKS}', batchMarkdown),
          validate: (t) => {
            if (!/^\s*\d+\./m.test(t))
              throw new Error('a rubrica deve ser uma lista numerada');
          },
        },
      ],
      { maxParallel: 1 },
    );
    const rubric =
      assertAllOk(rubricResult ? [rubricResult] : [])[0]?.text ?? '';
    await saveArtifact(join(arenaDir, 'rubric.md'), rubric, () => undefined);

    // 2. Candidates, in parallel, each in its own worktree.
    const devPrompt = buildDevPrompt({
      skillBody: devSkill.body,
      spec: inputs.spec,
      context: inputs.context,
      lessons: inputs.lessons,
      tasksPath: '(not available to candidates)',
      allowedCommands: allowed,
      batchMarkdown,
      batch,
    });
    const indexes = Array.from({ length: cfg.candidates }, (_, i) => i + 1);
    const outcomes = await mapLimit(
      indexes,
      ctx.config.subagents.max_parallel,
      async (index) => {
        const dir = join(arenaDir, `candidato-${index}`);
        // One model per candidate when `dev.arena.models` is set; otherwise the Dev's own.
        const model =
          cfg.models?.[(index - 1) % (cfg.models?.length || 1)] ??
          ctx.config.steps.dev.model;
        try {
          // A run that was interrupted leaves its worktrees behind, and `git worktree add` refuses a path that exists
          await removeWorktree(ctx.cwd, dir);
          await rm(dir, { recursive: true, force: true });
          await addWorktree(ctx.cwd, dir);
          worktrees.push(dir);
          const runner = deps.makeRunner({
            cwd: dir,
            runner: ctx.config.steps.dev.runner,
            ...(model ? { model } : {}),
            allowedCommands: allowed,
          });
          const report = await runner({
            prompt: devPrompt,
            files: [],
            canEdit: true,
          });
          const diff = await workingDiff(dir);
          if (diff.trim() === '') throw new Error('não mudou nada');
          return {
            ok: true as const,
            candidate: { index, dir, model, report, diff },
          };
        } catch (error) {
          return {
            ok: false as const,
            dropout: { index, reason: (error as Error).message },
          };
        }
      },
    );
    const candidates: Candidate[] = outcomes.flatMap((o) =>
      o.ok ? [o.candidate] : [],
    );
    const dropouts: Dropout[] = outcomes.flatMap((o) =>
      o.ok ? [] : [o.dropout],
    );
    for (const d of dropouts)
      io.write(`Candidato ${d.index} desistiu: ${d.reason}.`);
    if (candidates.length === 0) {
      throw new ArenaEscalation(
        'nenhum candidato entregou mudanças: a pessoa precisa decidir o que fazer.',
      );
    }

    let judgeText = 'sem juiz (candidato único)';
    let integrationText =
      'candidato único: aplicado ao projeto sem integração.';

    if (candidates.length === 1) {
      // 3'. A single survivor is the base. No judge, no graft.
      const only = candidates[0] as Candidate;
      const patch = join(arenaDir, 'candidato.patch');
      await writeFile(
        patch,
        only.diff.endsWith('\n') ? only.diff : `${only.diff}\n`,
      );
      await applyPatchFile(ctx.cwd, patch);
    } else {
      // 3. Judge: read-only, preferably another family than the Dev.
      const judgeTemplate = await loadReference(
        'dev',
        'judge-prompt',
        deps.skillsDir,
      );
      const judgeRunner = cfg.judge
        ? deps.makeRunner({
            cwd: ctx.cwd,
            runner: cfg.judge.runner,
            model: cfg.judge.model,
          })
        : ctx.runner;
      const [judged] = await runSubagents(
        judgeRunner,
        [
          {
            id: 'judge',
            prompt: judgeTemplate
              .replace('{RUBRIC}', rubric)
              .replace('{CANDIDATES}', renderCandidates(candidates)),
            validate: parseVerdict,
          },
        ],
        { maxParallel: 1 },
      );
      let verdict: Verdict | null = null;
      if (judged?.ok) {
        verdict = parseVerdict(judged.text);
        if (verdict.base === null) {
          throw new ArenaEscalation(
            `divergência total: o juiz não achou uma base razoável (${verdict.rationale}).`,
          );
        }
        judgeText = `base recomendada: candidato ${verdict.base}${verdict.convergence ? ' (os candidatos convergem)' : ''}. ${verdict.rationale}`;
      } else {
        judgeText = `o juiz não respondeu de forma válida (${judged && !judged.ok ? judged.error : 'sem resposta'}); a integração seguiu sem o veredito.`;
        io.write('O juiz do arena não respondeu; seguindo sem o veredito.');
      }

      // 4. Base and graft, by an editing Dev run in the real project.
      const integratorTemplate = await loadReference(
        'dev',
        'integrator-prompt',
        deps.skillsDir,
      );
      const integratorPrompt = `${devSkill.body}\n\n---\n\n${integratorTemplate
        .replace('{RUBRIC}', rubric)
        .replace(
          '{JUDGE}',
          verdict ? JSON.stringify(verdict) : '(the judge gave no verdict)',
        )
        .replace('{CANDIDATES}', renderCandidates(candidates))}`;
      const integrated = await ctx.runner({
        prompt: integratorPrompt,
        files: [],
        canEdit: true,
      });
      if (/^\s*ARENA-DIVERGENCE\b/.test(integrated)) {
        throw new ArenaEscalation(
          `divergência total: o integrador não achou uma base razoável.\n${integrated.trim()}`,
        );
      }
      integrationText =
        /## Arena note[\s\S]*$/.exec(integrated)?.[0] ?? integrated.trim();
    }

    // 5. Verify the result with the project's own commands. The worktrees go first: they
    // sit inside the project, so lint and the tests would read every copy of the code.
    await removeWorktrees();
    const checks = await runChecks(ctx.cwd, ctx.config.dev.check_commands);
    const checksText =
      checks.length === 0
        ? 'nenhum comando para verificar'
        : checks.map((c) => `- \`${c.command}\`: ${c.detail}`).join('\n');

    // 6. Note.
    const note = `# Arena - lote ${batch.index} de ${batch.total}

## Candidatos
- Iniciados: ${cfg.candidates}. Entregaram: ${candidates.length}.
${dropouts.length > 0 ? dropouts.map((d) => `- Desistência do candidato ${d.index}: ${d.reason}`).join('\n') : '- Nenhuma desistência.'}

## Rubrica
Em \`rubric.md\`, nesta pasta.

## Veredito do juiz
${judgeText}

## Integração
${integrationText}

## Verificação
${checksText}
`;
    await saveArtifact(join(arenaDir, 'arena.md'), note, () => undefined);
    return { note };
  } finally {
    // The worktrees always go, even when the arena fails or escalates.
    await removeWorktrees();
  }
}
