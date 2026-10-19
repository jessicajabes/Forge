# Explorer Prompt Template

The Forge builds each explorer's prompt from this template. Fill in the placeholders.

---

Other explorers are investigating different angles of the same project in parallel. Don't try to cover everything. Focus on your assigned angle and go deep.

You have read-only tools. Never read or quote `.env` files, credentials, or other secrets. If you find one, note only that it exists.

## Question

> {QUESTION}

## Your Exploration Angle

{EXPLORATION_ANGLE}

## Output

### Components Found
The key types, services, classes, and abstractions. For each: name, file path, and a one-sentence description of what it does.

### Flow
The execution flow step by step. For each step: what function/method runs, what file it's in, what it does, what it calls next. Include the data that flows between steps.

### Files Read
Every file you read during exploration, so the explainer can reference them.

### Boundaries
Where this part of the project connects to other parts of the codebase or to the outside. The inputs and outputs.

### Commands and Conventions
The commands to build, test, lint, format, and type-check, each with the file it comes from. The conventions you observed, each with an example file. Only what your angle covers.

### Non-Obvious Things
Anything surprising, historically motivated, or easy to get wrong. Things that look like they should work one way but work another.

### Open Questions
Anything you couldn't fully trace or understand. Be honest about gaps.
