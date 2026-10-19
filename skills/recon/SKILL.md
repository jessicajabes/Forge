---
name: recon
description: Lê o repositório-alvo e escreve o resumo de contexto (.workflow/context.md) que as outras etapas leem.
sources:
  - source: https://github.com/backnotprop/pstack
    source_skill: how
  - source: https://github.com/addyosmani/agent-skills
    source_skill: context-engineering
license: MIT
adapted: true
---

# Recon

Explore the target repository and write the project context file, `.workflow/context.md`. Later stages (tasks, dev, review) read it so their work follows the patterns already in the project, stays compatible with its technologies, and does not break what exists. Produce an explanation at the level of a senior engineer onboarding onto the project: enough to build a working mental model, not so much that it reads like annotated source code.

The Forge runs the roles below. Every one is read-only. Nobody edits files or runs commands.

## Question

The question is fixed, because the context is cached and does not depend on the current task:

> How is this project built, and what must a change respect to fit in?

## 1. Assess complexity

The Forge decides, from the size of the repository, which path to take:

- **Simple** (a small repository): no explorers. One explainer explores and writes the context file in one pass, built from `references/explainer-prompt.md` with the explorer-findings section empty. Go to step 3.
- **Complex**: go to step 2.

## 2. Explore (complex only)

Three explorers run in parallel, one per angle. Each is built from `references/explorer-prompt.md` with its angle filled in.

1. **Structure and stack.** Directory layout, entry points, modules or packages and what each one owns, languages, frameworks, and the main dependencies (read them from the manifests and lockfiles, not from memory).
2. **Conventions and tooling.** The commands to build, test, lint, format, and type-check, and the file each comes from (manifests, scripts, CI). Code conventions seen in sibling files: naming, exports, error handling, test layout and style. Existing rules files for agents or contributors: `CLAUDE.md`, `AGENTS.md`, `README`, `CONTRIBUTING`, `.github/copilot-instructions.md`, `.cursorrules`.
3. **Runtime flow and boundaries.** The main flows end to end, the integrations (databases, external APIs, queues), where input is validated, and what is risky to break: shared modules, public contracts, schemas.

## 3. Synthesize

Once the explorers have returned, one explainer reconciles their findings and writes the context file, built from `references/explainer-prompt.md`. The Forge saves its output as `.workflow/context.md`.

## Output format

The context file uses these sections, in this order. Drop any that do not apply:

- **Overview**: what the project is and does.
- **Tech Stack**: languages, frameworks, and main dependencies, with versions when the manifests give them.
- **Commands**: build, test, lint, format, type-check. Only commands found in the repository.
- **Code Conventions**: what the code actually does, not what a style guide would say.
- **Boundaries**: what a change must respect: public contracts, shared modules, validation points, and any rule from the project's own rules files.
- **Patterns**: the recurring patterns, each with the file where a good example lives.
- **Project Map**: one entry per module: path, purpose, key files, the pattern it follows.
- **Gotchas**: non-obvious or surprising things. Skip if there are none.

Every claim cites a file. Say "not found" instead of guessing, and never invent a command. Never read or quote `.env` files, credentials, or other secrets.
