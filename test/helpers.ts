import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A throwaway git repo with one commit, on the given branch. */
export async function makeRepo(branch = 'feature/x'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-repo-'));
  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-q', '-b', branch);
  run('config', 'user.email', 'forge@example.test');
  run('config', 'user.name', 'Forge Test');
  await writeFile(join(dir, 'a.txt'), 'a\n');
  run('add', 'a.txt');
  run('commit', '-q', '-m', 'init');
  return dir;
}
