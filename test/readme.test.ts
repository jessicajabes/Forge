import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseFlags } from '../src/cli.js';

describe('README', () => {
  it('only mentions npm scripts that exist and flags the CLI accepts', async () => {
    const readme = await readFile('README.md', 'utf-8');
    const pkg = JSON.parse(await readFile('package.json', 'utf-8')) as {
      scripts: Record<string, string>;
    };

    for (const [, script] of readme.matchAll(/npm run ([\w:-]+)/g)) {
      expect(pkg.scripts, `npm run ${script}`).toHaveProperty(script ?? '');
    }
    // only the flags in the usage table belong to forge-jj; the README also names
    // flags of other tools (such as --yolo) to say they are never used
    for (const [, found] of readme.matchAll(/^\| `(--[a-z-]+)/gm)) {
      const flag = found ?? '';
      const value =
        flag === '--arena'
          ? ['2']
          : flag === '--size'
            ? ['trivial']
            : flag === '--review'
              ? ['final']
              : [];
      expect(() => parseFlags(['x', flag, ...value]), flag).not.toThrow();
    }
  });

  it('carries the login notice and cites the three sources of the skills', async () => {
    const readme = await readFile('README.md', 'utf-8');
    expect(readme).toMatch(/their own\*\* login, \*\*only for themselves/);
    expect(readme).toContain('does not offer a login');
    for (const repo of [
      'mattpocock/skills',
      'backnotprop/pstack',
      'addyosmani/agent-skills',
    ]) {
      expect(readme).toContain(repo);
    }
    expect(readme).toContain('THIRD_PARTY_LICENSES.md');
  });

  it('does not mention an employer or internal systems', async () => {
    const readme = await readFile('README.md', 'utf-8');
    expect(readme).not.toMatch(/bemobi|git-m4u|bitbucket|orka/i);
  });
});
