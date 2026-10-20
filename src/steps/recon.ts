import { copyFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { saveArtifact } from '../artifacts.js';
import { git, headHash } from '../git.js';
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
  // The answer is saved as is, so any text before the title would end up in the file
  if (!text.startsWith('# '))
    throw new Error(
      'o resumo deve começar com o título "# Project: <nome>", sem texto antes',
    );
  if (!/^##\s+Overview\s*$/m.test(text))
    throw new Error('falta a seção "Overview"');
  if (text.trim().length < 200) throw new Error('o resumo está curto demais');
}

/** The context shared by all runs, and the commit it was built from. */
function sharedPaths(cwd: string): { context: string; meta: string } {
  const dir = workflowDir(cwd);
  return { context: join(dir, 'context.md'), meta: join(dir, 'context.json') };
}

async function builtAt(metaPath: string): Promise<string | null> {
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as {
      commit?: unknown;
    };
    return typeof meta.commit === 'string' ? meta.commit : null;
  } catch {
    return null;
  }
}

/**
 * True when the repo changed since `commit` in a way the context may not describe:
 * a commit that is not the Forge's own (no `Forge-Run` trailer) and touches a file
 * outside `.workflow/`. An unknown commit (rebased away, shallow clone) counts as stale.
 */
async function changedSince(cwd: string, commit: string): Promise<boolean> {
  let log: string;
  try {
    log = await git(cwd, [
      'log',
      '--format=%x1e%B%x1f',
      '--name-only',
      `${commit}..HEAD`,
    ]);
  } catch {
    return true;
  }
  return log
    .split('\x1e')
    .slice(1)
    .some((entry) => {
      const [message = '', files = ''] = entry.split('\x1f');
      if (/^Forge-Run:/m.test(message)) return false;
      return files
        .split('\n')
        .some((f) => f.trim() !== '' && !f.startsWith('.workflow/'));
    });
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
 * Keeps one `.workflow/context.md` for all runs (DESIGN 4.9) and copies it into the run
 * folder, where the other stages read it. It is rebuilt when the repo changed since it was
 * built (see `changedSince`) or with `--refresh-context`. A trivial run reuses it as it is
 * and says how old it is.
 */
export function createReconStage(options: ReconOptions): StageFn {
  return async (ctx: RunContext) => {
    const target = join(ctx.run.dir, 'context.md');
    const shared = sharedPaths(ctx.cwd);
    const now = options.now?.() ?? new Date();

    if (!options.refreshContext) {
      const commit = await builtAt(shared.meta);
      let mtime: Date | null = null;
      try {
        mtime = (await stat(shared.context)).mtime;
      } catch {
        // no shared context yet
      }
      if (mtime && commit) {
        const stale = await changedSince(ctx.cwd, commit);
        if (ctx.size === 'trivial' || !stale) {
          await copyFile(shared.context, target);
          options.io.write(
            stale
              ? `Reaproveitando o ${ageText(mtime, now)}, mas o repo mudou desde então. Use --refresh-context para refazer.`
              : `Reaproveitando o ${ageText(mtime, now)}: o repo não mudou desde então.`,
          );
          return;
        }
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
    const text = ok?.text ?? '';
    const commit = await headHash(ctx.cwd).catch(() => null);
    await saveArtifact(shared.context, text, validateContext);
    await saveArtifact(
      shared.meta,
      JSON.stringify({ commit }),
      () => undefined,
    );
    await copyFile(shared.context, target);
  };
}
