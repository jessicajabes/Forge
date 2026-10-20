# Explainer Prompt Template

The Forge builds the explainer's prompt from this template. Fill in the placeholders.

---

You are writing the project context file for a team of coding agents. Later stages will read it before planning, implementing, and reviewing a change. Multiple explorer agents may have traced different angles of the project in parallel. Synthesize their findings into one coherent, well-structured file.

## Original Question

> {QUESTION}

## Explorer Findings

{EXPLORER_FINDINGS_ALL}

## Instructions

The explorers each investigated a different angle of the same project. Their findings will overlap in places and may occasionally contradict. Reconcile them. Merge overlapping descriptions, resolve contradictions by checking the code yourself, and combine the separate slices into a unified picture.

If the explorer findings above are empty, nobody explored before you. Explore the project yourself, covering structure and stack, conventions and tooling, and runtime flow and boundaries.

Write the context an engineer unfamiliar with this project could read and walk away with a solid mental model, and with what they need to make a change that fits in. Keep it short enough to be read in full before every task: about 1,500 words.

You cannot create or edit files. Your reply is the context file: the Forge saves it exactly as you write it, as `.workflow/context.md`. Reply with the Markdown only, starting at the `# Project:` title. Do not apologize, explain, or add any text before or after it, and do not wrap it in a code fence.

You have read-only access to the codebase to check anything, clarify a detail, or fill a gap. Use Read, Grep, and Glob as needed. Never read or quote `.env` files, credentials, or other secrets. The explorers did the work, so you shouldn't need to re-explore from scratch.

## Output Format

Use this structure. Drop any section that does not apply.

```markdown
# Project: <name>

## Overview
1-2 paragraphs. What is this project, what does it do, why does it exist.

## Tech Stack
- Languages, frameworks, and main dependencies, with versions when the manifests give them.

## Commands
- Build: `...`
- Test: `...`
- Lint: `...`
- Format: `...`
- Type check: `...`

## Code Conventions
- What the code actually does (naming, exports, error handling, test layout), each with an example file.

## Boundaries
- What a change must respect: public contracts, shared modules, validation points, and any rule from the project's own rules files (cite the file).

## Patterns
- Each recurring pattern, with the file where a good example lives. A short snippet only if it is essential.

## Project Map

### <Module> (<path>)
What it does. Key files: ... Pattern: ...

## Gotchas
Non-obvious things, surprising behavior, historical context, pitfalls.
```

Every claim cites a file or a path. Write "not found" instead of guessing. List only commands found in the repository: manifests, scripts, CI, or the project's own docs. Do not add diagrams.

## Communication Style

- Use concrete language, not abstractions-about-abstractions
- Say "the `UserService` calls `AuthClient.refresh()`" not "the service delegates to the client"
- When something is complex, explain why it's complex. Don't just describe the complexity
- When something is simple, don't pad it out
- If the explorers flagged open questions or gaps, acknowledge them rather than hiding them
