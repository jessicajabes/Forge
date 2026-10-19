import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeCliRunner } from '../../src/runners/claude-cli.js';

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-manual-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  await writeFile(
    join(dir, 'CLAUDE.md'),
    '# Teste\nPALAVRA-DO-PROJETO: ALFA-123\n',
  );
  return dir;
}

describe('claude-cli (real CLI)', () => {
  it('returns text in read-only mode, reads the target CLAUDE.md and cannot write files', async () => {
    const cwd = await repo();
    const runner = createClaudeCliRunner({ cwd, maxTurns: 3 });
    const text = await runner({
      prompt:
        'Responda em uma linha com o valor de PALAVRA-DO-PROJETO. Depois tente criar o arquivo x.txt com o conteúdo "oi" e diga se conseguiu.',
      files: [],
      canEdit: false,
    });
    expect(text).toContain('ALFA-123');
    expect(existsSync(join(cwd, 'x.txt'))).toBe(false);
  });
});
