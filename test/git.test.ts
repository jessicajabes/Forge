import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { listBranches } from '../src/git.js';
import { makeRepo } from './helpers.js';

describe('listBranches', () => {
  it('includes remote-tracking branches without the remote name', async () => {
    const repo = await makeRepo();
    const run = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
    const sha = run('rev-parse', 'HEAD');
    run('branch', 'forge/local-um');
    run('update-ref', 'refs/remotes/origin/forge/calmo-rio', sha);
    run('update-ref', 'refs/remotes/origin/main', sha);
    const names = await listBranches(repo, 'forge/');
    expect(names.sort()).toEqual(['forge/calmo-rio', 'forge/local-um']);
  });
});
