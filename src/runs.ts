import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './git.js';

const WORKFLOW_DIR = '.workflow';

export function workflowDir(cwd: string): string {
  return join(cwd, WORKFLOW_DIR);
}

export function slugify(text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'tarefa';
}

export type Run = {
  id: string;
  slug: string;
  dir: string;
};

/** Creates `.workflow/runs/<date>-<slug>/`. A repeated name gets a numeric suffix. */
export async function createRun(
  cwd: string,
  task: string,
  now: Date = new Date(),
): Promise<Run> {
  const slug = slugify(task);
  const date = now.toISOString().slice(0, 10);
  const runs = join(workflowDir(cwd), 'runs');
  await mkdir(runs, { recursive: true });
  for (let n = 1; ; n++) {
    const id = n === 1 ? `${date}-${slug}` : `${date}-${slug}-${n}`;
    const dir = join(runs, id);
    try {
      await mkdir(dir);
      return { id, slug, dir };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

const EXCLUDE_LINES = ['.workflow/', '.workflow.yml'];

/**
 * Adds `.workflow/` and `.workflow.yml` to `.git/info/exclude` (the local gitignore).
 * The project's own `.gitignore` is never touched. Returns the lines that were added.
 */
export async function ensureLocalExclude(cwd: string): Promise<string[]> {
  const path = await git(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'info/exclude',
  ]);
  let current = '';
  try {
    current = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(join(path, '..'), { recursive: true });
  }
  const present = new Set(current.split('\n').map((l) => l.trim()));
  const missing = EXCLUDE_LINES.filter((l) => !present.has(l));
  if (missing.length > 0) {
    const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
    await appendFile(path, `${prefix}${missing.join('\n')}\n`);
  }
  return missing;
}

// ---------- lock: one active run per repo ----------

export class LockedError extends Error {
  constructor(public readonly pid: number) {
    super(
      `já existe uma execução do Forge ativa neste repositório (pid ${pid})`,
    );
    this.name = 'LockedError';
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes the repo lock. A lock left by a dead process is taken over. */
export async function acquireLock(cwd: string): Promise<() => Promise<void>> {
  const path = join(workflowDir(cwd), 'lock');
  await mkdir(workflowDir(cwd), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, String(process.pid), { flag: 'wx' });
      return async () => {
        await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number.parseInt(
        await readFile(path, 'utf-8').catch(() => ''),
        10,
      );
      if (Number.isInteger(pid) && pid !== process.pid && isAlive(pid))
        throw new LockedError(pid);
      await rm(path, { force: true });
    }
  }
  throw new LockedError(-1);
}
