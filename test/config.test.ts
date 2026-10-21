import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_WORKFLOW_YML,
  devBatching,
  ensureWorkflowFile,
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

  it('keeps the arena off unless dev.arena.enabled is set', () => {
    expect(parseConfig('').dev.arena.enabled).toBe(false);
    expect(
      parseConfig('dev: { arena: { candidates: 2 } }').dev.arena.enabled,
    ).toBe(false);
    expect(
      parseConfig('dev: { arena: { enabled: true } }').dev.arena.enabled,
    ).toBe(true);
  });

  it('kills a silent claude after 2 minutes by default, and 0 turns it off', () => {
    expect(parseConfig('').claude.inactivity_kill_minutes).toBe(2);
    expect(
      parseConfig('claude: { inactivity_kill_minutes: 5 }').claude
        .inactivity_kill_minutes,
    ).toBe(5);
    expect(
      parseConfig('claude: { inactivity_kill_minutes: 0 }').claude
        .inactivity_kill_minutes,
    ).toBe(0);
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
    expect(devBatching(parseConfig('review_mode: final'))).toBe('all');
    expect(devBatching(parseConfig('review_mode: per_task'))).toBe('per_task');
  });

  it('dev.batching: per_task splits the Dev while the review stays final', () => {
    const config = parseConfig(
      'review_mode: final\ndev: { batching: per_task }',
    );
    expect(config.review_mode).toBe('final');
    expect(devBatching(config)).toBe('per_task');
  });

  it('review_mode defaults to final: one Dev call, the checks, then one review', () => {
    expect(parseConfig('').review_mode).toBe('final');
    expect(parseConfig('dev: { batching: all }').review_mode).toBe('final');
    expect(parseConfig('dev: { batching: per_task }').review_mode).toBe(
      'final',
    );
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

describe('DEFAULT_WORKFLOW_YML', () => {
  it('passes the schema with the default models, reviewers and arena', () => {
    const config = parseConfig(DEFAULT_WORKFLOW_YML);
    expect(config.steps.grill.model).toBe('claude-opus-5-5');
    expect(config.steps.recon.model).toBe('claude-haiku-5-5');
    expect(config.steps.tasks.model).toBe('claude-haiku-5-5');
    expect(config.steps.dev.model).toBe('claude-sonnet-5-5');
    expect(config.steps.review.model).toBe('claude-opus-5-5');
    expect(config.steps.review.reviewers).toEqual([
      { runner: 'claude-cli', model: 'claude-sonnet-5-5' },
      { runner: 'copilot-cli', model: 'auto' },
    ]);
    expect(config.steps.lessons).toEqual({
      runner: 'claude-cli',
      model: 'claude-haiku-5-5',
    });
    expect(config.dev.arena.enabled).toBe(false);
    expect(config.dev.arena.candidates).toBe(3);
    expect(config.dev.arena.judge).toEqual({
      runner: 'claude-cli',
      model: 'claude-opus-5-5',
    });
  });
});

describe('ensureWorkflowFile', () => {
  it('creates .workflow.yml when it is missing and returns true', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-cfg-'));
    expect(await ensureWorkflowFile(dir)).toBe(true);
    expect(await readFile(join(dir, '.workflow.yml'), 'utf-8')).toBe(
      DEFAULT_WORKFLOW_YML,
    );
  });

  it('never changes an existing file, even an empty one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-cfg-'));
    await writeFile(join(dir, '.workflow.yml'), '');
    expect(await ensureWorkflowFile(dir)).toBe(false);
    expect(await readFile(join(dir, '.workflow.yml'), 'utf-8')).toBe('');
  });
});
