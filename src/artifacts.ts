import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

/** Thrown when a stage artifact does not match its fixed structure (DESIGN 4.1). */
export class ArtifactError extends Error {
  constructor(
    public readonly artifact: string,
    public readonly problems: string[],
  ) {
    super(`${artifact}: ${problems.join('; ')}`);
    this.name = 'ArtifactError';
  }
}

const PROVISIONAL = '(provisória)';

// ---------- spec.md (DESIGN 5.1) ----------

const SPEC_SECTIONS = [
  'Objetivo',
  'Decisões',
  'Fora do escopo',
  'Restrições',
  'Pontos em aberto',
] as const;

const specSchema = z.object({
  title: z.string().min(1, 'título vazio'),
  goal: z.string().min(1, 'a seção Objetivo está vazia'),
  decisions: z.array(z.object({ text: z.string(), provisional: z.boolean() })),
  outOfScope: z.array(z.string()),
  constraints: z.array(z.string()),
  openPoints: z.array(z.string()),
});

export type Spec = z.infer<typeof specSchema>;

function bullets(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(
      (l) =>
        l.length > 0 &&
        l.toLowerCase() !== 'nenhum' &&
        l.toLowerCase() !== 'nenhuma',
    );
}

export function parseSpec(markdown: string): Spec {
  const problems: string[] = [];
  const lines = markdown.split('\n');
  const titleLine = lines.find((l) => l.trim().length > 0) ?? '';
  const titleMatch = /^#\s+Spec:\s*(.+)$/.exec(titleLine);
  if (!titleMatch) problems.push('falta o título "# Spec: <título>"');

  const sections = new Map<string, string>();
  const order: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = h[1] ?? null;
      if (current) {
        order.push(current);
        sections.set(current, '');
      }
    } else if (current) {
      sections.set(current, `${sections.get(current) ?? ''}${line}\n`);
    }
  }
  for (const name of SPEC_SECTIONS) {
    if (!sections.has(name)) problems.push(`falta a seção "${name}"`);
  }
  const expected = SPEC_SECTIONS.filter((s) => sections.has(s));
  if (
    JSON.stringify(order.filter((s) => expected.includes(s as never))) !==
    JSON.stringify(expected)
  ) {
    problems.push('as seções estão fora da ordem');
  }
  if (problems.length > 0) throw new ArtifactError('spec.md', problems);

  const get = (name: string) => sections.get(name) ?? '';
  const parsed = specSchema.safeParse({
    title: titleMatch?.[1]?.trim() ?? '',
    goal: get('Objetivo').trim(),
    decisions: bullets(get('Decisões')).map((text) => ({
      text,
      provisional: text.includes(PROVISIONAL),
    })),
    outOfScope: bullets(get('Fora do escopo')),
    constraints: bullets(get('Restrições')),
    openPoints: bullets(get('Pontos em aberto')),
  });
  if (!parsed.success) {
    throw new ArtifactError(
      'spec.md',
      parsed.error.issues.map((i) => i.message),
    );
  }
  return parsed.data;
}

// ---------- tasks.md (DESIGN 5.2) ----------

const taskSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1, 'título da tarefa vazio'),
  files: z.array(z.string()).min(1, 'a tarefa não lista arquivos'),
  what: z.string().min(1, 'a tarefa não diz o que fazer'),
  criteria: z
    .array(z.object({ done: z.boolean(), text: z.string().min(1) }))
    .min(1, 'a tarefa não tem critério de aceite'),
  dependsOn: z.array(z.number().int().positive()),
});

export type Task = z.infer<typeof taskSchema>;
export type TaskList = { tasks: Task[]; doubts: string[] };

const FIELD =
  /^-\s+\*\*(Arquivos|O que fazer|Critério de aceite|Depende de)\*\*:\s*(.*)$/;

function parseTaskBlock(block: string[], id: number, title: string): unknown {
  const fields: Record<string, string[]> = {};
  let current: string | null = null;
  for (const raw of block) {
    const m = FIELD.exec(raw);
    if (m) {
      current = m[1] ?? null;
      if (current) fields[current] = m[2] ? [m[2]] : [];
    } else if (current && raw.trim().length > 0) {
      fields[current]?.push(raw);
    }
  }
  const criteria = (fields['Critério de aceite'] ?? [])
    .map((l) => /^\s*-\s+\[( |x|X)\]\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ done: m[1] !== ' ', text: (m[2] ?? '').trim() }));
  const depends = (fields['Depende de'] ?? []).join(' ').trim();
  const dependsOn =
    depends === '' || /^nenhuma\.?$/i.test(depends)
      ? []
      : depends.split(/[,\s]+/).map((d) => {
          const n = /^T(\d+)$/.exec(d.trim());
          return n ? Number(n[1]) : Number.NaN;
        });
  return {
    id,
    title,
    files: (fields['Arquivos'] ?? [])
      .join(' ')
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f.length > 0),
    what: (fields['O que fazer'] ?? []).join(' ').trim(),
    criteria,
    dependsOn,
  };
}

export function parseTasks(markdown: string): TaskList {
  const problems: string[] = [];
  const lines = markdown.split('\n');
  if (!lines.some((l) => /^#\s+Tarefas\s*$/.test(l)))
    problems.push('falta o título "# Tarefas"');

  const tasks: Task[] = [];
  const doubts: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const t = /^##\s+T(\d+):\s*(.*)$/.exec(line);
    if (t) {
      const id = Number(t[1]);
      const block: string[] = [];
      i++;
      while (i < lines.length && !/^##\s/.test(lines[i] ?? ''))
        block.push(lines[i++] ?? '');
      const result = taskSchema.safeParse(
        parseTaskBlock(block, id, (t[2] ?? '').trim()),
      );
      if (result.success) tasks.push(result.data);
      else
        for (const issue of result.error.issues)
          problems.push(`T${id}: ${issue.message}`);
      continue;
    }
    if (/^##\s+Dúvidas\s*$/.test(line)) {
      i++;
      while (i < lines.length && !/^##\s/.test(lines[i] ?? '')) {
        const d = (lines[i] ?? '').trim();
        if (d.startsWith('- ')) doubts.push(d.slice(2).trim());
        i++;
      }
      continue;
    }
    i++;
  }

  if (tasks.length === 0 && problems.length === 0)
    problems.push('nenhuma tarefa encontrada');
  tasks.forEach((task, index) => {
    if (task.id !== index + 1) {
      problems.push(
        `T${task.id}: a numeração deve ser sequencial (esperado T${index + 1})`,
      );
    }
    for (const dep of task.dependsOn) {
      if (Number.isNaN(dep))
        problems.push(`T${task.id}: "Depende de" tem valor inválido`);
      else if (dep >= task.id) {
        problems.push(
          `T${task.id}: depende de T${dep}, que não é uma tarefa anterior`,
        );
      }
    }
  });
  if (problems.length > 0) throw new ArtifactError('tasks.md', problems);
  return { tasks, doubts };
}

// ---------- atomic write (DESIGN 4.1) ----------

/**
 * Validates `content`, then writes it to `path` through a temp file and a rename,
 * so the file is either the old version or the new one, never half written.
 */
export async function saveArtifact(
  path: string,
  content: string,
  validate: (content: string) => unknown,
): Promise<void> {
  validate(content);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
