---
name: tasks
description: Quebra a spec em tarefas ordenadas, pequenas e verificáveis (tasks.md).
source: https://github.com/addyosmani/agent-skills
source_skill: planning-and-task-breakdown
license: MIT
adapted: true
---

# Tasks

Turn the approved spec into an ordered list of small, verifiable tasks. The Dev stage implements exactly what you write here, so a vague task becomes a vague change. Good task breakdown is the difference between a Dev that finishes reliably and one that produces a tangled mess.

You are read-only. Do not write code, edit files, or run commands. Read the inputs, then answer with the full contents of `tasks.md` and nothing else. The Forge validates the structure and saves the file. If the structure is broken it asks you again, so follow the format below exactly.

## Inputs

- `spec.md`: the goal, the decisions, what is out of scope, the constraints, and the open points. Decisions marked `(provisória)` were guessed, not confirmed. Do not build a task on a provisional decision without saying so in the task.
- `context.md`: how the project is built and what a change must respect.
- `lessons.md`, if it exists: rules learned from earlier runs. Apply them. Do not repeat a mistake the lessons already name.

Read only these files and the code you need to place each task. Do not reread the whole repository: `context.md` already summarizes it.

## What every task must respect

- the pattern already in the project (naming, layout, error handling, test style);
- compatibility with the technologies and versions in use;
- the project context in `context.md`;
- that nothing existing breaks. If a task changes a shared module or a public contract, say which callers it touches and add a criterion that proves they still work.

## Process

### 1. Map the dependencies

Find what depends on what: types before the code that uses them, a shared module before its callers, a schema before the queries. Implementation order follows the graph from the bottom up.

### 2. Slice vertically

Build one complete path at a time, not one layer at a time.

- Bad (horizontal): "all the types", then "all the endpoints", then "all the screens", then "connect everything".
- Good (vertical): "user can create an account (schema, API, UI)", then "user can log in", and so on.

Each task delivers something that works and can be tested alone. Only slice horizontally when the project has no way to test a vertical slice yet, such as a shared base that every slice needs. Then make that base its own task and keep it small.

### 3. Size the tasks

| Size | Files | Example |
|---|---|---|
| XS | 1 | add a validation rule |
| S | 1-2 | add one endpoint |
| M | 3-5 | one feature slice |
| L or more | 6+ | too large: split it |

An agent works best on S and M tasks. Split a task when:

- it touches more than about 5 files;
- you cannot state its acceptance criteria in 3 or 4 checks;
- it touches two or more independent subsystems;
- its title needs the word "and".

Do not split into tiny tasks either. The Dev may run each task as its own batch (`review_mode: per_task`), and every batch costs a full Dev run with review. Prefer fewer, right-sized tasks.

### 4. Make each task a safe stopping point

The Forge may commit and review after any single task. So every task must:

- leave the project working: it builds (or passes a cheap typecheck, when the project has one) and its own targeted tests pass. Only the full suite, lint and format are global checks left out of the tasks;
- be checkable on its own, without waiting for a later task;
- depend only on earlier tasks, never on a later one.

Put the riskiest or least certain task early, so a wrong assumption fails fast. Every 2 or 3 tasks, make sure the last task of the group ends in a criterion that shows the whole flow so far working (build, typecheck, or an end-to-end behavior), not only its own change.

### 5. Write the acceptance criteria

Every criterion must be checkable by a command or an observable behavior: a targeted test that passes, a response a person can see. "Works well" and "is clean" are not criteria.

- Use only commands found in `context.md` or in the repo. Never invent a command. If the project has no way to check the behavior, say so in the task, and write the criterion as an observable behavior.
- Each task carries only the criteria for its own behavior. A task that changes behavior includes a criterion for the new or updated test of that behavior.
- A test criterion runs only the task's own test file or filter (for example `npm test -- <path>`), using a command that is in `dev.allowed_commands`. If no allowed command can run a single file, say so under `## Dúvidas` instead of requiring the full suite.
- Do not add formatting (`prettier`), full test-suite, or lint criteria to any task. They are global checks, not part of a task's own behavior, and are left out of `tasks.md`. This applies to both `per_task` and final review modes.

## Output format

Answer with this structure, in the language the spec is written in. Keep the headings and field names as they are.

```markdown
# Tarefas

## T1: <title>
- **Arquivos**: src/..., src/...
- **O que fazer**: <one short paragraph: what to change and why, not a line-by-line recipe>
- **Critério de aceite**:
  - [ ] `<command or observable behavior>` shows ...
  - [ ] A new test for ... passes
- **Depende de**: nenhuma
```

Rules for the format:

- Number tasks `T1`, `T2`, ... in the order they should run.
- `Arquivos` lists the files the task is likely to touch, as paths. Say "novo" next to a file to create.
- `Depende de` lists task numbers (`T1, T2`) or `nenhuma`. A task may only depend on a lower number.
- Do not add a "how to implement" field beyond `O que fazer`. The Dev decides the details. Do not write code.
- The Dev marks the boxes `[x]` when done, so keep each box a single check.

## Respect the spec

- Do not add a task for anything under "Fora do escopo".
- Cover every decision in `Decisões` that needs a change in the code. A decision with no task is a gap; flag it.
- If `Pontos em aberto` still has items that affect a task, say in that task which open point it waits on. Do not guess the answer.
- If you cannot break the work into tasks without a missing decision, say what is missing at the end under `## Dúvidas` as a short list. The Forge shows it at the human stop.

## Common mistakes

| Mistake | What to do instead |
|---|---|
| "The tasks are obvious" | Write them down anyway. It shows hidden dependencies and forgotten edge cases. |
| One task per layer | Slice vertically, one working path per task. |
| "Implement the feature" with no criteria | Add checks a command can verify. |
| A task that only passes once a later task exists | Reorder, or merge the two. |
| A command in a criterion that is not in the repo | Read `context.md`; use only real commands. |
| Prettier, lint, or a full test run in every task | Leave them out. They are global checks, not part of a task. Use only a targeted test for the task's own behavior. |
| One huge task to save batches | Split it by the rules in step 3. |

## Check before you answer

- [ ] Every task has at least one checkable acceptance criterion.
- [ ] Every command in a criterion exists in `context.md` or the repo.
- [ ] No task has a prettier, lint, or full test-suite criterion.
- [ ] Every dependency points to a lower task number.
- [ ] No task is larger than about 5 files, and none has "and" in its title.
- [ ] Every task leaves the project working on its own.
- [ ] Nothing from "Fora do escopo" appears, and every decision that changes code has a task.
- [ ] The rules in `lessons.md` are applied.
