import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  devBatching,
  loadConfig,
  parseConfig,
} from '../src/config.js';
import { estimateDevCost } from '../src/costEstimate.js';

describe('config', () => {
  it('uses the defaults when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-cfg-'));
    const config = await loadConfig(dir);
    expect(config.review_mode).toBe('final');
    expect(config.max_review_cycles).toBe(10);
    expect(config.dev.arena.candidates).toBe(3);
    expect(config.dev.allowed_commands).toEqual([
      'npm test',
      'npm run lint',
      'npx prettier',
    ]);
    expect(config.claude.isolated).toBe(true);
  });

  it('defaults max_review_cycles to 10 and honors an explicit value', () => {
    expect(parseConfig('').max_review_cycles).toBe(10);
    expect(parseConfig('max_review_cycles: 2').max_review_cycles).toBe(2);
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

describe('dev.batching and the dev limits', () => {
  it('the Dev has no turn or time limit unless they are set', () => {
    const config = parseConfig('');
    expect(config.dev.max_turns).toBeUndefined();
    expect(config.dev.timeout_minutes).toBeUndefined();
    expect(
      parseConfig('dev: { max_turns: 90, timeout_minutes: 120 }').dev,
    ).toMatchObject({ max_turns: 90, timeout_minutes: 120 });
  });

  it('follows review_mode when dev.batching is not set', () => {
    expect(devBatching(parseConfig(''))).toBe('all');
    expect(devBatching(parseConfig('review_mode: per_task'))).toBe('per_task');
  });

  it('dev.batching: per_task splits the Dev while the review stays final', () => {
    const config = parseConfig('dev: { batching: per_task }');
    expect(config.review_mode).toBe('final');
    expect(devBatching(config)).toBe('per_task');
  });

  it('refuses a per-task review with a single Dev call', () => {
    expect(() =>
      parseConfig('review_mode: per_task\ndev: { batching: all }'),
    ).toThrow(ConfigError);
  });

  it('the cost estimate counts one batch per task when the Dev is split', () => {
    const config = parseConfig('dev: { batching: per_task }');
    const estimate = estimateDevCost({
      config,
      taskCount: 4,
      size: 'complete',
    });
    expect(estimate.batches).toBe(4);
  });
});
