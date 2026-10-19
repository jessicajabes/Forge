import type { IO } from '../src/io.js';

export type FakeIO = IO & {
  /** Everything written, joined by newlines. */
  output: () => string;
  /** The questions asked, in order. */
  questions: string[];
};

/** An IO that answers from a script and records what was shown. */
export function createFakeIO(answers: string[]): FakeIO {
  const written: string[] = [];
  const questions: string[] = [];
  let next = 0;
  return {
    write: (text) => {
      written.push(text);
    },
    ask: async (question) => {
      questions.push(question);
      const answer = answers[next++];
      if (answer === undefined)
        throw new Error(`FakeIO: no answer left for "${question}"`);
      return answer;
    },
    close: () => undefined,
    output: () => written.join('\n'),
    questions,
  };
}
