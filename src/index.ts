#!/usr/bin/env node
import { main } from './cli.js';
import { createReadlineIO } from './io.js';
import type { Config } from './config.js';
import type { RunnerFactory } from './runner.js';
import { createClaudeCliRunner } from './runners/claude-cli.js';
import { createAntigravityCliRunner } from './runners/antigravity-cli.js';
import { createCopilotCliRunner } from './runners/copilot-cli.js';

const io = createReadlineIO();

function makeRunner(config: Config): RunnerFactory {
  // The limits of `dev` only apply to editing calls; the runners ignore them otherwise
  const editTimeoutMs =
    config.dev.timeout_minutes !== undefined
      ? config.dev.timeout_minutes * 60_000
      : undefined;
  return (opts) =>
    opts.runner === 'antigravity-cli'
      ? createAntigravityCliRunner({
          cwd: opts.cwd,
          ...(editTimeoutMs !== undefined ? { editTimeoutMs } : {}),
          ...(opts.model ? { model: opts.model } : {}),
        })
      : opts.runner === 'copilot-cli'
        ? createCopilotCliRunner({
            cwd: opts.cwd,
            ...(editTimeoutMs !== undefined ? { editTimeoutMs } : {}),
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.allowedCommands
              ? { allowedCommands: opts.allowedCommands }
              : {}),
          })
        : createClaudeCliRunner({
            cwd: opts.cwd,
            isolated: config.claude.isolated,
            inactivityKillMs: config.claude.inactivity_kill_minutes * 60_000,
            ...(config.dev.max_turns !== undefined
              ? { editMaxTurns: config.dev.max_turns }
              : {}),
            ...(editTimeoutMs !== undefined ? { editTimeoutMs } : {}),
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.allowedCommands
              ? { allowedCommands: opts.allowedCommands }
              : {}),
            notice: (message) => io.write(message),
          });
}

main(process.argv.slice(2), {
  cwd: process.cwd(),
  isTTY: Boolean(process.stdin.isTTY),
  io,
  makeRunner,
}).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
