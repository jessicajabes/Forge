import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillError, loadSkill } from '../src/skills.js';

async function skillsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-skills-'));
  for (const [stage, content] of Object.entries(files)) {
    await mkdir(join(dir, stage), { recursive: true });
    await writeFile(join(dir, stage, 'SKILL.md'), content, 'utf-8');
  }
  return dir;
}

describe('loadSkill', () => {
  it('strips the frontmatter and returns the body and metadata', async () => {
    const dir = await skillsDir({
      tasks:
        '---\nname: tasks\nadapted: true\nlicense: MIT\n---\n\n# Tasks\n\nBody text.\n',
    });
    const skill = await loadSkill('tasks', dir);
    expect(skill.body).toBe('# Tasks\n\nBody text.\n');
    expect(skill.meta['name']).toBe('tasks');
    expect(skill.body).not.toContain('license');
  });

  it('works for a skill with no frontmatter', async () => {
    const dir = await skillsDir({ grill: '# Grill\n' });
    expect((await loadSkill('grill', dir)).body).toBe('# Grill\n');
  });

  it('fails when the stage has no skill', async () => {
    const dir = await skillsDir({});
    await expect(loadSkill('dev', dir)).rejects.toThrow(SkillError);
    await expect(loadSkill('dev', dir)).rejects.toThrow(/não encontrada/);
  });

  it('refuses a skill marked adapted: false', async () => {
    const dir = await skillsDir({
      dev: '---\nname: dev\nadapted: false\n---\n# Arena\n',
    });
    await expect(loadSkill('dev', dir)).rejects.toThrow(/adapted: false/);
  });

  it('loads the adapted skills shipped in the repo', async () => {
    for (const stage of ['grill', 'recon', 'tasks', 'review'] as const) {
      const skill = await loadSkill(stage);
      expect(skill.body.length).toBeGreaterThan(100);
      expect(skill.body.startsWith('---')).toBe(false);
    }
  });
});
