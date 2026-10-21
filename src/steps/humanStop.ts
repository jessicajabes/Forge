import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArtifactError, parseTasks } from '../artifacts.js';
import { estimateDevCost } from '../costEstimate.js';
import type { IO } from '../io.js';
import { RunCancelled, type StageFn } from '../orchestrator.js';

export type OpenEditor = (path: string) => Promise<void>;

/** Opens `$EDITOR` (or `vi`) on the file and waits for it to close. */
export const openDefaultEditor: OpenEditor = (path) =>
  new Promise((resolve, reject) => {
    const [cmd = 'vi', ...args] = (process.env['EDITOR'] ?? 'vi').split(/\s+/);
    const child = spawn(cmd, [...args, path], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', () => resolve());
  });

type Choice = 'approve' | 'edit' | 'cancel' | 'no-arena';

function parseChoice(answer: string): Choice | null {
  const a = answer.trim().toLowerCase();
  if (a === '') return null;
  if ('aprovar'.startsWith(a)) return 'approve';
  if ('editar'.startsWith(a)) return 'edit';
  if ('cancelar'.startsWith(a)) return 'cancel';
  if ('rodar sem arena'.startsWith(a) || 'sem arena'.startsWith(a))
    return 'no-arena';
  return null;
}

/**
 * The only stop of the flow (DESIGN 4.10): after Tasks, before Dev. Shows the task
 * list, the open doubts and the relative cost, and waits for approve | edit | cancel |
 * run without arena. Dev never starts before `aprovar`.
 */
export function createHumanStop(
  io: IO,
  openEditor: OpenEditor = openDefaultEditor,
): StageFn {
  return async (ctx) => {
    const tasksPath = join(ctx.run.dir, 'tasks.md');
    for (;;) {
      const markdown = await readFile(tasksPath, 'utf-8');
      let list;
      try {
        list = parseTasks(markdown);
      } catch (error) {
        if (!(error instanceof ArtifactError)) throw error;
        io.write(`O tasks.md está inválido: ${error.problems.join('; ')}`);
        const again = parseChoice(await io.ask('editar | cancelar: '));
        if (again === 'cancel') throw new RunCancelled();
        await openEditor(tasksPath);
        continue;
      }

      io.write(markdown);
      if (list.doubts.length > 0) {
        io.write(
          `Dúvidas em aberto:\n${list.doubts.map((d) => `- ${d}`).join('\n')}`,
        );
      }
      io.write(
        estimateDevCost({
          config: ctx.config,
          taskCount: list.tasks.length,
          size: ctx.size,
        }).text,
      );

      const choice = parseChoice(
        await io.ask('aprovar | editar | cancelar | rodar sem arena: '),
      );
      switch (choice) {
        case 'approve':
          return;
        case 'cancel':
          throw new RunCancelled();
        case 'edit':
          await openEditor(tasksPath);
          break;
        case 'no-arena':
          ctx.config = {
            ...ctx.config,
            dev: {
              ...ctx.config.dev,
              arena: { ...ctx.config.dev.arena, enabled: false, candidates: 1 },
            },
          };
          io.write('Arena desligado para esta execução.');
          return;
        default:
          io.write('Resposta não reconhecida.');
      }
    }
  };
}
