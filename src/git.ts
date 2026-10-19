import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} falhou: ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

/** Runs `git <args>` in `cwd` and returns trimmed stdout. Never goes through a shell. */
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    throw new GitError(
      args,
      (error as { stderr?: string }).stderr ?? String(error),
    );
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

/** Current branch name, or null on a detached HEAD. Works before the first commit. */
export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  } catch {
    return null;
  }
}

/** True when there is nothing to commit: no changes and no untracked files. */
export async function isClean(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain'])) === '';
}

export async function branchExists(
  cwd: string,
  name: string,
): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

export async function checkout(
  cwd: string,
  branch: string,
  create = false,
): Promise<void> {
  await git(
    cwd,
    create ? ['checkout', '-q', '-b', branch] : ['checkout', '-q', branch],
  );
}

export async function headHash(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', 'HEAD']);
}

/**
 * Stages everything and commits it locally. Returns the new hash, or null when there
 * was nothing to commit. The Forge never pushes (DESIGN 4.6).
 */
export async function commitAll(
  cwd: string,
  subject: string,
  trailers: string[],
): Promise<string | null> {
  await git(cwd, ['add', '-A']);
  if ((await git(cwd, ['status', '--porcelain'])) === '') return null;
  await git(cwd, ['commit', '-q', '-m', subject, '-m', trailers.join('\n')]);
  return headHash(cwd);
}

/** The diff a batch introduced: `git diff <from> <to>`. */
export async function diffBetween(
  cwd: string,
  from: string,
  to = 'HEAD',
): Promise<string> {
  return git(cwd, ['diff', from, to]);
}
