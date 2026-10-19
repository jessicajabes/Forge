import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { saveArtifact } from './artifacts.js';
import type { Run } from './runs.js';
import { workflowDir } from './runs.js';

export const NOTHING_TO_RESUME = 'Não há execução incompleta para retomar.';

const stateSchema = z.object({
  task: z.string(),
  size: z.enum(['complete', 'trivial']),
  /** Stages that ran to the end, in order. */
  completed: z.array(z.string()),
  /** `running` covers a run that was interrupted: it can be resumed. */
  status: z.enum(['running', 'completed', 'cancelled']),
  updatedAt: z.string(),
});

export type RunState = z.infer<typeof stateSchema>;

const STATE_FILE = 'state.json';

export async function readState(runDir: string): Promise<RunState | null> {
  try {
    return stateSchema.parse(
      JSON.parse(await readFile(join(runDir, STATE_FILE), 'utf-8')),
    );
  } catch {
    return null;
  }
}

export async function writeState(
  runDir: string,
  state: Omit<RunState, 'updatedAt'>,
): Promise<void> {
  const full: RunState = { ...state, updatedAt: new Date().toISOString() };
  await saveArtifact(
    join(runDir, STATE_FILE),
    `${JSON.stringify(full, null, 2)}\n`,
    (text) => stateSchema.parse(JSON.parse(text)),
  );
}

export type IncompleteRun = { run: Run; state: RunState };

/** The most recently updated run that was interrupted, or null (DESIGN 3.3). */
export async function findIncompleteRun(
  cwd: string,
): Promise<IncompleteRun | null> {
  const runsDir = join(workflowDir(cwd), 'runs');
  let ids: string[];
  try {
    ids = await readdir(runsDir);
  } catch {
    return null;
  }
  let best: IncompleteRun | null = null;
  for (const id of ids) {
    const dir = join(runsDir, id);
    const state = await readState(dir);
    if (!state || state.status !== 'running') continue;
    if (!best || state.updatedAt > best.state.updatedAt) {
      best = { run: { id, slug: id, dir }, state };
    }
  }
  return best;
}
