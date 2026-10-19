import { copyFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { saveArtifact } from '../artifacts.js';
import { git } from '../git.js';
import type { IO } from '../io.js';
import type { RunContext, StageFn } from '../orchestrator.js';
import { workflowDir } from '../runs.js';
import { loadReference, loadSkill } from '../skills.js';
import { assertAllOk, runSubagents } from '../subagents.js';

/** Up to this many tracked files, one explainer reads the repo alone (DESIGN 4.9). */
export const SMALL_REPO_FILES = 100;

const QUESTION =
  'How is this project built, and what must a change respect to fit in?';

const ANGLES = [
  {
    id: 'structure-and-stack',
    text: 'Structure and stack. Directory layout, entry points, modules or packages and what each one owns, languages, frameworks, and the main dependencies (read them from the manifests and lockfiles, not from memory).',
  },
  {
    id: 'conventions-and-tooling',
    text: 'Conventions and tooling. The commands to build, test, lint, format, and type-check, and the file each comes from (manifests, scripts, CI). Code conventions seen in sibling files: naming, exports, error handling, test layout and style. Existing rules files for agents or contributors: `CLAUDE.md`, `AGENTS.md`, `README`, `CONTRIBUTING`, `.github/copilot-instructions.md`, `.cursorrules`.',
  },
  {
    id: 'flow-and-boundaries',
    text: 'Runtime flow and boundaries. The main flows end to end, the integrations (databases, external APIs, queues), where input is validated, and what is risky to break: shared modules, public contracts, schemas.',
  },
] as const;

export function validateContext(text: string): void {
  if (!/^##\s+Overview\s*$/m.test(text))
    throw new Error('falta a seção "Overview"');
  if (text.trim().length < 200) throw new Error('o resumo está curto demais');
}

/** The newest context.md from an earlier run, or null. */
async function lastContext(
  cwd: string,
  currentRunDir: string,
): Promise<{ path: string; mtime: Date } | null> {
  const runs = join(workflowDir(cwd), 'runs');
  let ids: string[];
  try {
    ids = await readdir(runs);
  } catch {
    return null;
  }
  let best: { path: string; mtime: Date } | null = null;
  for (const id of ids) {
    const path = join(runs, id, 'context.md');
    if (join(runs, id) === currentRunDir) continue;
    try {
      const { mtime } = await stat(path);
      if (!best || mtime > best.mtime) best = { path, mtime };
    } catch {
      // this run has no context.md
    }
  }
  return best;
}

function ageText(mtime: Date, now: Date): string {
  const days = Math.floor((now.getTime() - mtime.getTime()) / 86_400_000);
  if (days <= 0) return 'contexto de hoje';
  return `contexto de ${days} ${days === 1 ? 'dia' : 'dias'} atrás`;
}

export type ReconOptions = {
  io: IO;
  /** `--refresh-context`: rebuild even on a trivial task. */
  refreshContext?: boolean;
  skillsDir?: string;
  now?: () => Date;
};

/**
 * Writes `context.md` into the run folder (DESIGN 4.9). A full run always rebuilds it.
 * A trivial run copies the last one and says how old it is; with none, it builds a new one.
 */
export function createReconStage(options: ReconOptions): StageFn {
  return async (ctx: RunContext) => {
    const target = join(ctx.run.dir, 'context.md');
    const now = options.now?.() ?? new Date();

    if (ctx.size === 'trivial' && !options.refreshContext) {
      const previous = await lastContext(ctx.cwd, ctx.run.dir);
      if (previous) {
        await copyFile(previous.path, target);
        options.io.write(
          `Reaproveitando o ${ageText(previous.mtime, now)}. Use --refresh-context para refazer.`,
        );
        return;
      }
    }

    const skill = await loadSkill('recon', options.skillsDir);
    const explorerTemplate = await loadReference(
      'recon',
      'explorer-prompt',
      options.skillsDir,
    );
    const explainerTemplate = await loadReference(
      'recon',
      'explainer-prompt',
      options.skillsDir,
    );

    const tracked = (await git(ctx.cwd, ['ls-files']))
      .split('\n')
      .filter((l) => l.length > 0);
    let findings = '';
    if (tracked.length > SMALL_REPO_FILES) {
      const results = await runSubagents(
        ctx.runner,
        ANGLES.map((angle) => ({
          id: angle.id,
          prompt: `${skill.body}\n\n---\n\n${explorerTemplate
            .replace('{QUESTION}', QUESTION)
            .replace('{EXPLORATION_ANGLE}', angle.text)}`,
        })),
        { maxParallel: ctx.config.subagents.max_parallel },
      );
      findings = assertAllOk(results)
        .map((r) => `### Explorer: ${r.id}\n\n${r.text}`)
        .join('\n\n');
    }

    const explainerPrompt = `${skill.body}\n\n---\n\n${explainerTemplate
      .replace('{QUESTION}', QUESTION)
      .replace('{EXPLORER_FINDINGS_ALL}', findings)}`;
    const [result] = await runSubagents(
      ctx.runner,
      [{ id: 'explainer', prompt: explainerPrompt, validate: validateContext }],
      { maxParallel: 1 },
    );
    const [ok] = assertAllOk(result ? [result] : []);
    await saveArtifact(target, ok?.text ?? '', validateContext);
  };
}
