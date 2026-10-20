import { describe, expect, it } from 'vitest';
import { splitBatches, taskBlocks } from '../src/steps/dev.js';
import { parseTasks } from '../src/artifacts.js';

const task = (n: number) => `## T${n}: Tarefa ${n}
- **Arquivos**: src/f${n}.ts
- **O que fazer**: Fazer ${n}.
- **Critério de aceite**:
  - [ ] \`npm test\` passa
- **Depende de**: nenhuma
`;
const TASKS = `# Tarefas\n\n${[1, 2, 3].map(task).join('\n')}`;

describe('batches', () => {
  it('final is one batch with every task; per_task is one batch per task', () => {
    const { tasks } = parseTasks(TASKS);
    expect(splitBatches(tasks, 'final')).toHaveLength(1);
    expect(splitBatches(tasks, 'final')[0]?.tasks).toHaveLength(3);
    expect(splitBatches(tasks, 'per_task').map((b) => b.tasks.length)).toEqual([
      1, 1, 1,
    ]);
  });

  it('extracts the block of each task', () => {
    const blocks = taskBlocks(TASKS);
    expect([...blocks.keys()]).toEqual([1, 2, 3]);
    expect(blocks.get(2)).toContain('## T2: Tarefa 2');
    expect(blocks.get(2)).not.toContain('T3');
  });
});
