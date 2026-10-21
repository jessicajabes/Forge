import { join } from 'node:path';
import { saveArtifact, type Task } from './artifacts.js';

/** `tarefas/T<n>/<name>` in the run folder: the Dev and review documents of one task live together. */
export const taskDocPath = (
  runDir: string,
  id: number | 'geral',
  name: string,
) => join(runDir, 'tarefas', id === 'geral' ? id : `T${id}`, name);

/** The sections of a Dev report that start with `## T<n>`, keyed by task number. */
export function splitReportByTask(report: string): Map<number, string> {
  const sections = new Map<number, string>();
  for (const part of report.split(/^(?=#{2,3}\s+T\d+\b)/m)) {
    const m = /^#{2,3}\s+T(\d+)\b/.exec(part);
    if (m) sections.set(Number(m[1]), part.trimEnd());
  }
  return sections;
}

/**
 * Files the Dev report under each task it covers (`tarefas/T<n>/dev.md`). A task the report
 * does not mention gets a pointer to the whole report, so no task folder is left without a Dev document.
 */
export async function writeDevTaskDocs(
  runDir: string,
  tasks: Task[],
  report: string,
  reportFile: string,
): Promise<void> {
  const sections = splitReportByTask(report);
  for (const task of tasks) {
    const own = sections.get(task.id);
    const body = own
      ? `# Dev da T${task.id}: ${task.title}\n\n${own.replace(/^#{2,3}\s+T\d+[^\n]*\n*/, '')}\n`
      : `# Dev da T${task.id}: ${task.title}\n\nO relatório do Dev não tem uma seção própria para esta task. Veja \`${reportFile}\`.\n`;
    await saveArtifact(
      taskDocPath(runDir, task.id, 'dev.md'),
      body,
      () => undefined,
    );
  }
}
