import { devBatching, type Config } from './config.js';
import type { TaskSize } from './orchestrator.js';

export type CostEstimate = {
  batches: number;
  arena: boolean;
  /** Model calls the Dev stage makes for one batch. */
  callsPerBatch: number;
  totalCalls: number;
  /** One line for the human stop. */
  text: string;
};

/**
 * A relative estimate, in model calls, because `claude -p` does not report real cost
 * (DESIGN 4.10). With the arena a batch is: rubric, N candidates, judge, integration.
 */
export function estimateDevCost(opts: {
  config: Config;
  taskCount: number;
  size: TaskSize;
}): CostEstimate {
  const { config, taskCount, size } = opts;
  const candidates = config.dev.arena.candidates;
  const arena = size !== 'trivial' && candidates > 1;
  const batches =
    devBatching(config) === 'per_task' ? Math.max(taskCount, 1) : 1;
  const callsPerBatch = arena ? candidates + 3 : 1;
  const totalCalls = callsPerBatch * batches;
  const how = arena ? `arena com ${candidates} candidatos` : 'Dev simples';
  const batchWord = batches === 1 ? 'lote' : 'lotes';
  return {
    batches,
    arena,
    callsPerBatch,
    totalCalls,
    text: `Custo estimado do Dev (${how}): ~${callsPerBatch} chamadas por lote × ${batches} ${batchWord} = ~${totalCalls} chamadas.`,
  };
}
