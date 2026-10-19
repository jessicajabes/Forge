import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'yaml';

export const STAGES = [
  'grill',
  'recon',
  'tasks',
  'dev',
  'review',
  'lessons',
] as const;
export type Stage = (typeof STAGES)[number];

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillError';
  }
}

export type Skill = {
  stage: Stage;
  /** Frontmatter fields (name, description, source, adapted, ...). */
  meta: Record<string, unknown>;
  /** The Markdown body, without the frontmatter. */
  body: string;
};

/** `skills/` at the package root, next to `src/`. */
const DEFAULT_SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url));

function splitFrontmatter(text: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = parse(match[1] ?? '') as unknown;
  return {
    meta:
      meta !== null && typeof meta === 'object'
        ? (meta as Record<string, unknown>)
        : {},
    body: (match[2] ?? '').replace(/^\s+/, ''),
  };
}

/**
 * Reads the stage's SKILL.md and strips the frontmatter (DESIGN 4.12).
 * A skill still marked `adapted: false` is a literal copy of the source and
 * must not be sent to a model.
 */
export async function loadSkill(
  stage: Stage,
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<Skill> {
  const path = join(skillsDir, stage, 'SKILL.md');
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    throw new SkillError(`skill da etapa "${stage}" não encontrada em ${path}`);
  }
  const { meta, body } = splitFrontmatter(text);
  if (meta['adapted'] === false) {
    throw new SkillError(
      `a skill "${stage}" ainda tem adapted: false e não pode ser carregada por uma etapa`,
    );
  }
  return { stage, meta, body };
}
