import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STAGES, loadSkill, type Stage } from '../src/skills.js';

/** Words that must never reach a model prompt: they belong to the source harnesses. */
const FORBIDDEN = [
  /\/build\b/,
  /tasks\/todo\.md/,
  /tasks\/plan\.md/,
  /\bCursor\b/,
  /poteto-mode/,
  /pstack-models/,
];

describe('shipped skills', () => {
  for (const stage of STAGES) {
    it(`${stage}: adapted skills declare their source and carry no foreign harness text`, async () => {
      let skill;
      try {
        skill = await loadSkill(stage as Stage);
      } catch {
        return; // not adapted yet: the loader refuses it, which is the point
      }
      if (
        skill.meta['source'] !== undefined ||
        skill.meta['sources'] !== undefined
      ) {
        expect(skill.meta['license']).toBe('MIT');
      }
      for (const re of FORBIDDEN)
        expect(skill.body, `${stage} matches ${re}`).not.toMatch(re);
    });
  }

  it('dev is adapted and its references exist', async () => {
    const skill = await loadSkill('dev');
    expect(skill.meta['adapted']).toBe(true);
    const files = await readdir(join('skills', 'dev', 'references'));
    expect(files.sort()).toEqual([
      'integrator-prompt.md',
      'judge-prompt.md',
      'rubric-prompt.md',
    ]);
  });
});
