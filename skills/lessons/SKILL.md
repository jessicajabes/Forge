---
name: lessons
description: Propõe lições novas para o lessons.md a partir dos artefatos da execução (review.md, arena.md, tasks.md, spec.md e o diff dos commits). O usuário aprova uma por uma.
source: https://github.com/backnotprop/pstack
source_skill: reflect
license: MIT
adapted: true
---

# Lessons

Mine the artifacts of one finished run for durable learnings, and propose them as one-line rules for `lessons.md`. A lesson is a rule that would have prevented a problem this run hit, and that will help the next run on this project. One-offs are not lessons.

The Forge runs this stage with three lenses in parallel and one synthesizer after them. Each lens reads a different slice of the run, finds candidate rules, and returns them with evidence. The synthesizer merges the candidates and returns the final list. Nothing is written until the person approves each rule, one by one. Do not write to any file yourself.

## What you may read

Only these, all from this run:

- `review.md`: the reviewer's findings, the Dev's answers, what was kept, closed, noted or dismissed, and how the review ended;
- `arena.md` (one per batch, when the arena ran): who dropped out, the judge's verdict, what was grafted or rejected, and the result of the checks;
- `tasks.md` and `spec.md`: what was asked, and which decisions were provisional;
- the diff of the commits of the run, when a finding points at code;
- `lessons.md`, the rules that already exist.

Never read or ask for the conversation of the Grill, a CLI session transcript, `.env` files, keys, or other secrets. If a file you need is missing, say so and go on with what you have.

## What makes a good lesson

- **A rule, in one sentence.** "Every new route needs a test for the error path." Not a story, not a diagnosis.
- **Durable.** It holds beyond this task. A fact about one file, one bug or one deadline is not a lesson.
- **Grounded.** It cites where the run showed it: a section of `review.md`, a finding, a failed check. A rule with no evidence is a guess.
- **Checkable.** Another agent can tell from a diff whether the rule was followed.
- **New.** It does not repeat or contradict `lessons.md`. If it refines an old rule, say which one.
- **Not better enforced by a tool.** If a lint rule, a type, or a test would catch it every time, say that, instead of adding a rule people must remember.

## Candidate format

Each lens returns a list. One candidate per item, in exactly this form:

```
- RULE: <one sentence, an instruction>
  EVIDENCE: <file and section, or finding title, that shows it>
  TASK: <T1 | none>
  WHY IT LASTS: <one line on why it is not a one-off>
```

If the lens finds nothing worth a rule, return `No candidates.` and stop. An empty result is a valid outcome.

## Synthesizer output

The synthesizer returns one JSON object and nothing else, with the text fields in the language of the project:

```json
{
  "accepted": [
    { "rule": "<one sentence>", "task": "T1 | null", "evidence": "<where the run showed it>", "lenses": ["judgment", "tooling"] }
  ],
  "rejected": [
    { "rule": "<the candidate>", "reason": "<one line: one-off, duplicate of lessons.md, no evidence, or better enforced by a tool>" }
  ]
}
```

Rules for the synthesizer:

- Merge candidates that say the same thing. A rule raised by two or more lenses is stronger.
- Reject one-offs, duplicates of `lessons.md`, rules with no evidence, and rules a tool would enforce better.
- Keep the accepted list short. A handful of strong rules beat a long list. The project keeps a limited number of lessons.
- Do not invent a rule that no lens proposed.
