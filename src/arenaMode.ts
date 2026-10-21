import { UsageError } from './cli.js';
import type { Config } from './config.js';
import type { TaskSize } from './orchestrator.js';

export type ArenaMode = { enabled: boolean; candidates: number };

export type ArenaFlags = {
  arena?: { candidates?: number };
  noArena?: boolean;
};

/**
 * The single place that decides whether the Dev runs in an arena. The arena is opt-in
 * (`dev.arena.enabled` or `--arena`); a trivial task and `candidates <= 1` always run a plain
 * Dev (DESIGN 3.2). `--arena <n>` overrides `candidates` for this run only.
 */
export function resolveArenaMode(
  config: Config,
  size: TaskSize,
  flags: ArenaFlags = {},
): ArenaMode {
  if (flags.arena !== undefined && flags.noArena)
    throw new UsageError('--arena e --no-arena não podem ser usados juntos');
  const enabled = flags.noArena
    ? false
    : flags.arena !== undefined || config.dev.arena.enabled;
  const candidates = flags.arena?.candidates ?? config.dev.arena.candidates;
  const on = enabled && candidates > 1 && size !== 'trivial';
  return { enabled: on, candidates: on ? candidates : 1 };
}
