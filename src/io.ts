import { createInterface } from 'node:readline/promises';

/** What the stages need from a terminal: show text and read one answer (DESIGN 4.8). */
export interface IO {
  write(text: string): void;
  ask(question: string): Promise<string>;
  close(): void;
}

/** A plain `readline` terminal. A TUI can replace it later without touching the stages. */
export function createReadlineIO(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): IO {
  const rl = createInterface({ input, output });
  return {
    write: (text) => {
      output.write(text.endsWith('\n') ? text : `${text}\n`);
    },
    ask: (question) => rl.question(question),
    close: () => rl.close(),
  };
}
