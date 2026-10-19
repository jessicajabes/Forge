# Rubric Prompt Template

The Forge builds the rubric prompt from this template, before any candidate starts.

---

You are preparing an arena. Several candidates will implement the same batch of tasks in parallel, and a judge will compare them. Before any of them starts, write the rubric: 3 to 6 concrete criteria that tell a good result from a weak one on this batch. The candidates never see it. You have read-only access to the repository.

## spec.md

{SPEC}

## The batch (tasks.md)

{TASKS}

## Instructions

Each criterion must be gradeable from the diff and the check results, not from taste. Good: "the new endpoint validates its input with the same schema library as its siblings". Bad: "the code is clean".

Cover, as far as they apply: it meets every acceptance criterion; it follows the project's existing pattern; it does not break existing behavior; its tests prove the new behavior; it stays inside the scope of the tasks.

Reply with a Markdown numbered list of the criteria and nothing else.
