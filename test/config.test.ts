import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from '../src/config.js';

describe('config', () => {
  it('uses the defaults when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-cfg-'));
    const config = await loadConfig(dir);
    expect(config.review_mode).toBe('final');
    expect(config.max_review_cycles).toBe(3);
    expect(config.dev.arena.candidates).toBe(3);
    expect(config.dev.allowed_commands).toEqual([
      'npm test',
      'npm run lint',
      'npx prettier',
    ]);
    expect(config.claude.isolated).toBe(true);
  });

  it('keeps claude.isolated true unless it is turned off explicitly', () => {
    expect(parseConfig('review_mode: per_task').claude.isolated).toBe(true);
    expect(parseConfig('claude: { isolated: false }').claude.isolated).toBe(
      false,
    );
  });

  it('merges a partial file with the defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-cfg-'));
    await writeFile(
      join(dir, '.workflow.yml'),
      'review_mode: per_task\ndev:\n  arena:\n    candidates: 1\n',
    );
    const config = await loadConfig(dir);
    expect(config.review_mode).toBe('per_task');
    expect(config.dev.arena.candidates).toBe(1);
    expect(config.max_lessons).toBe(30);
  });

  it('rejects an invalid field, an unknown field and bad context limits', () => {
    expect(() => parseConfig('review_mode: sometimes')).toThrow(ConfigError);
    expect(() => parseConfig('review_mode: sometimes')).toThrow(/review_mode/);
    expect(() => parseConfig('max_reviw_cycles: 2')).toThrow(ConfigError);
    expect(() => parseConfig('steps: { dev: { runner: gpt } }')).toThrow(
      /steps.dev.runner/,
    );
    expect(() =>
      parseConfig('max_context_tokens: { warn: 200, limit: 100 }'),
    ).toThrow(/warn/);
  });

  it('accepts the shipped .workflow.example.yml', async () => {
    const example = await readFile('.workflow.example.yml', 'utf-8');
    // the example uses <placeholders>, which are valid YAML strings
    const config = parseConfig(example);
    expect(config.steps.review.reviewers).toHaveLength(2);
    expect(config.steps.review.reviewers[1]?.runner).toBe('copilot-cli');
  });
});
