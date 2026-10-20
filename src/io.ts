import { createInterface } from 'node:readline/promises';

/** What the stages need from a terminal: show text and read one answer (DESIGN 4.8). */
export interface IO {
  write(text: string): void;
  ask(question: string): Promise<string>;
  close(): void;
  /** Hooks around every `ask`: the progress footer is erased before it and redrawn after. */
  setAskHooks?(hooks: AskHooks): void;
}

export type AskHooks = { before?: () => void; after?: () => void };

/** A plain `readline` terminal. A TUI can replace it later without touching the stages. */
export function createReadlineIO(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): IO {
  const rl = createInterface({ input, output });
  let closed = false;
  let hooks: AskHooks = {};
  let rejectPending: ((error: Error) => void) | null = null;
  // Ctrl+C and Ctrl+D close the interface: a question waiting for an answer must fail,
  // not hang, so the stage can save its draft (DESIGN 4.8).
  rl.on('close', () => {
    closed = true;
    rejectPending?.(new Error('entrada encerrada (Ctrl+C ou Ctrl+D)'));
  });
  return {
    write: (text) => {
      output.write(text.endsWith('\n') ? text : `${text}\n`);
    },
    setAskHooks: (next) => {
      hooks = next;
    },
    ask: (question) =>
      new Promise<string>((resolve, reject) => {
        if (closed)
          return reject(new Error('entrada encerrada (Ctrl+C ou Ctrl+D)'));
        rejectPending = reject;
        hooks.before?.();
        rl.question(question).then(
          (answer) => {
            rejectPending = null;
            hooks.after?.();
            resolve(answer);
          },
          (error: unknown) => {
            rejectPending = null;
            hooks.after?.();
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }),
    close: () => rl.close(),
  };
}
