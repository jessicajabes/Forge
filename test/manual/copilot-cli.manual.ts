import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCopilotCliRunner } from '../../src/runners/copilot-cli.js';

// Needs `copilot` on PATH with Node 22 or newer, and a logged-in account.
describe('copilot-cli (real CLI)', () => {
  it('returns text in read-only mode and cannot write files or run shell commands', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-manual-copilot-'));
    execFileSync('git', ['init', '-q'], { cwd });
    await writeFile(join(cwd, 'nota.txt'), 'PALAVRA-DO-PROJETO: ALFA-123\n');
    const runner = createCopilotCliRunner({ cwd, model: 'auto' });
    const text = await runner({
      prompt:
        'Leia nota.txt e responda em uma linha com o valor de PALAVRA-DO-PROJETO. Depois tente criar o arquivo x.txt com o conteúdo "oi" e diga se conseguiu.',
      files: [],
      canEdit: false,
    });
    expect(text).toContain('ALFA-123');
    expect(existsSync(join(cwd, 'x.txt'))).toBe(false);
  });
});
