import { currentBranch, isGitRepo, statusLines } from './git.js';
import { LockedError, acquireLock, ensureLocalExclude } from './runs.js';

export type PreflightCode =
  'no-tty' | 'not-git' | 'dirty-tree' | 'protected-branch' | 'locked';

export class PreflightError extends Error {
  constructor(
    public readonly code: PreflightCode,
    message: string,
  ) {
    super(message);
    this.name = 'PreflightError';
  }
}

export type PreflightResult = {
  /** Lines added to `.git/info/exclude` on this run (empty after the first run). */
  excluded: string[];
  /** Frees the repo lock. Call it when the run ends. */
  release: () => Promise<void>;
};

const PROTECTED_BRANCHES = ['main', 'master'];

/**
 * The conditions of DESIGN 3.1.1. Every refusal is one line telling what to do.
 * Order matters: the local exclude comes before the clean-tree check, so the
 * Forge's own `.workflow.yml` never makes the tree look dirty.
 */
export async function preflight(opts: {
  cwd: string;
  isTTY: boolean;
  /** A resumed run may have uncommitted work from the interrupted batch. */
  allowDirty?: boolean;
}): Promise<PreflightResult> {
  const { cwd, isTTY } = opts;
  if (!isTTY) {
    throw new PreflightError(
      'no-tty',
      'o Forge precisa de um terminal interativo (TTY).',
    );
  }
  if (!(await isGitRepo(cwd))) {
    throw new PreflightError(
      'not-git',
      'este diretório não é um repositório git: rode `git init`.',
    );
  }
  const excluded = await ensureLocalExclude(cwd);
  const dirty = opts.allowDirty ? [] : await statusLines(cwd);
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 5).map((l) => `  ${l}`);
    const more = dirty.length > 5 ? [`  ... e mais ${dirty.length - 5}`] : [];
    // `git stash` alone leaves untracked files (`??`) behind, so the tree would stay dirty
    const untracked = dirty.some((l) => l.startsWith('??'));
    throw new PreflightError(
      'dirty-tree',
      `há alterações não commitadas:\n${[...shown, ...more].join('\n')}\nFaça commit ou rode ${untracked ? '`git stash -u` (o `-u` guarda também os arquivos novos, marcados com ??)' : '`git stash`'} antes de continuar.`,
    );
  }
  const branch = await currentBranch(cwd);
  if (branch !== null && PROTECTED_BRANCHES.includes(branch)) {
    throw new PreflightError(
      'protected-branch',
      `o Forge não roda em "${branch}": crie ou troque para outra branch.`,
    );
  }
  try {
    const release = await acquireLock(cwd);
    return { excluded, release };
  } catch (error) {
    if (error instanceof LockedError) {
      throw new PreflightError(
        'locked',
        `${error.message}. Espere ela terminar.`,
      );
    }
    throw error;
  }
}
