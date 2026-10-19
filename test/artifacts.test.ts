import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ArtifactError,
  parseSpec,
  parseTasks,
  saveArtifact,
} from '../src/artifacts.js';

const SPEC = `# Spec: Login com Google

## Objetivo
Permitir login com a conta Google.

## Decisões
- Usar OAuth 2.0
- Guardar o token em cookie httpOnly (provisória)

## Fora do escopo
- Login com Facebook

## Restrições
- Sem nova dependência

## Pontos em aberto
- nenhum
`;

const TASKS = `# Tarefas

## T1: Rota de callback
- **Arquivos**: src/auth.ts, test/auth.test.ts (novo)
- **O que fazer**: Criar a rota de callback do OAuth.
- **Critério de aceite**:
  - [ ] \`npm test\` passa, com teste novo
  - [x] \`npm run lint\` sem erros
- **Depende de**: nenhuma

## T2: Botão de login
- **Arquivos**: src/ui.ts
- **O que fazer**: Mostrar o botão.
- **Critério de aceite**:
  - [ ] \`npm test\` passa
- **Depende de**: T1

## Dúvidas

- Qual provedor de sessão usar?
`;

describe('parseSpec', () => {
  it('parses a valid spec and detects provisional decisions', () => {
    const spec = parseSpec(SPEC);
    expect(spec.title).toBe('Login com Google');
    expect(spec.decisions).toHaveLength(2);
    expect(spec.decisions[1]?.provisional).toBe(true);
    expect(spec.openPoints).toEqual([]);
  });

  it('reports a missing section', () => {
    const broken = SPEC.replace(
      '## Restrições\n- Sem nova dependência\n\n',
      '',
    );
    expect(() => parseSpec(broken)).toThrow(ArtifactError);
    expect(() => parseSpec(broken)).toThrow(/falta a seção "Restrições"/);
  });
});

describe('parseTasks', () => {
  it('parses valid tasks, criteria state, dependencies and doubts', () => {
    const { tasks, doubts } = parseTasks(TASKS);
    expect(tasks.map((t) => t.id)).toEqual([1, 2]);
    expect(tasks[0]?.files).toEqual([
      'src/auth.ts',
      'test/auth.test.ts (novo)',
    ]);
    expect(tasks[0]?.criteria.map((c) => c.done)).toEqual([false, true]);
    expect(tasks[0]?.dependsOn).toEqual([]);
    expect(tasks[1]?.dependsOn).toEqual([1]);
    expect(doubts).toEqual(['Qual provedor de sessão usar?']);
  });

  it('rejects a task with no acceptance criteria', () => {
    const broken = TASKS.replace(
      /- \*\*Critério de aceite\*\*:\n {2}- \[ \] `npm test` passa\n/,
      '',
    );
    expect(() => parseTasks(broken)).toThrow(/critério de aceite/);
  });

  it('rejects a dependency on a task with a higher number', () => {
    const broken = TASKS.replace(
      '**Depende de**: nenhuma',
      '**Depende de**: T2',
    );
    expect(() => parseTasks(broken)).toThrow(/não é uma tarefa anterior/);
  });

  it('rejects non-sequential numbering and missing tasks', () => {
    expect(() => parseTasks(TASKS.replace('## T2:', '## T3:'))).toThrow(
      /sequencial/,
    );
    expect(() => parseTasks('# Tarefas\n')).toThrow(/nenhuma tarefa/);
  });
});

describe('saveArtifact', () => {
  it('writes a valid artifact and leaves no temp file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-art-'));
    const path = join(dir, 'runs', 'r1', 'tasks.md');
    await saveArtifact(path, TASKS, parseTasks);
    expect(await readFile(path, 'utf-8')).toBe(TASKS);
    expect(await readdir(join(dir, 'runs', 'r1'))).toEqual(['tasks.md']);
  });

  it('keeps the old file and leaves nothing partial when validation fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-art-'));
    const path = join(dir, 'tasks.md');
    await writeFile(path, TASKS, 'utf-8');
    await expect(
      saveArtifact(path, '# Tarefas\nlixo', parseTasks),
    ).rejects.toThrow(ArtifactError);
    expect(await readFile(path, 'utf-8')).toBe(TASKS);
    expect(await readdir(dir)).toEqual(['tasks.md']);
  });

  it('does not create the file when the first write is invalid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-art-'));
    await expect(
      saveArtifact(join(dir, 'spec.md'), 'x', parseSpec),
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('the project backlog', () => {
  it('is a valid tasks.md for the Forge itself', async () => {
    const md = await readFile('tasks.md', 'utf-8');
    const { tasks } = parseTasks(md);
    expect(tasks.length).toBeGreaterThan(20);
  });
});
