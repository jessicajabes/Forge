# Forge

A TypeScript CLI that routes a coding task through a fixed, human-approved LLM workflow inside your repository.

Forge is not a model. It is a program that decides the order of the steps, reads and writes the artifacts between them, and calls the agents you already have installed (Claude Code and GitHub Copilot CLI) at each step.

> **Status: pre-release.** Not published to npm yet. Run it from a clone with `npm link`.

## The workflow

```
1. Grill    interviews you, one question at a time, until nothing is left to ask
2. Recon    reads the project and writes a context summary
3. Tasks    writes a list of small, verifiable tasks
            -> human stop: approve | edit | cancel | run without arena
4. Dev      implements each batch (by default in an arena: N candidates in parallel,
            a judge, and one integration that keeps the best of them)
5. Review   reviewers of different models attack the change, with correction cycles
6. Lessons  proposes rules for next time; you approve them one by one
```

Every stage reads the files the previous one wrote, never the conversation. Each stage also follows the same four rules: respect the project's existing patterns, stay compatible with its technologies, use the project context, and do not break what exists.

## Requirements

- Node.js 20 or newer
- `git`
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`), logged in
- Optional: [GitHub Copilot CLI](https://github.com/features/copilot/cli) (`copilot`), logged in. It adds models of other families for reviewers and the arena judge.

## Install

```sh
git clone https://github.com/jessicajabes/Forge.git
cd Forge
npm install
npm run build
npm link
```

## Use

Run it inside the repository you want to change:

```sh
forge-jj "add login with Google"
```

After the command it asks two questions (Enter takes the default):

```
How big is the task?    1) complete: with the interview (default)   2) trivial: skips the Grill
How to review?          1) at the end (default)                     2) per task
```

Flags skip the questions:

| Flag | Meaning |
|---|---|
| `--size <completo\|trivial>` | `completo` runs the Grill. `trivial` skips it and writes a minimal, provisional spec |
| `--review <final\|per_task>` | The reviewer checks everything at the end, or each task before the next |
| `--no-arena` | Plain Dev, no arena |
| `--arena <n>` | Number of arena candidates |
| `--refresh-context` | Rebuild the shared context summary even if the repo did not change |

`forge-jj` with no argument resumes the last interrupted run.

Forge is interactive only: it needs a terminal (a TTY) and refuses to run without one.

### During the Grill

| You type | What happens |
|---|---|
| Enter or `sim` | Accepts the recommended answer |
| any text | Your answer |
| `não sei` | Asks the model to break the question down. The second time, Forge follows the recommendation and marks the decision `(provisória)` |
| `depois` | Postpones the question: it becomes an open point |
| `voltar` | Undoes the last answer |
| `chega` | Ends the interview with what was decided so far |

Ctrl+C keeps a draft, and the next run offers to continue it.

## What Forge does to your repository

- It refuses to start outside a git repository, with uncommitted changes, or on `main` or `master`.
- The Dev works on its own branch `forge/<slug>` and makes one local commit per batch, after the review approves it.
- **It never pushes.** Nothing leaves your machine except the prompts sent to the agents you chose.
- Its files live in `.workflow/` and `.workflow.yml`. The first run adds both to `.git/info/exclude`; your `.gitignore` is never touched.
- Only one run at a time per repository.

Each run has its own folder, `.workflow/runs/<date>-<slug>/`, with `spec.md`, `tasks.md`, a copy of `context.md` and `review.md`. `.workflow/lessons.md` and `.workflow/context.md` are shared by all runs: the context is rebuilt only when the repo changed since it was made.

## Configuration

Copy [`.workflow.example.yml`](.workflow.example.yml) to `.workflow.yml` in the target repository. Every field is optional. You can pick a runner and a model per stage, several reviewers of different models, the number of arena candidates, one model per candidate, and the arena judge. `dev.batching: per_task` makes one Dev call per task (each committed as it ends) while the review stays at the end. Editing calls have no turn or time limit unless you set `dev.max_turns` or `dev.timeout_minutes`.

Without a config, everything runs on `claude-cli` with Claude Code's default model, with 3 arena candidates, review at the end, and at most 3 review cycles.

## Credentials and terms of use

Forge has no API key and no login of its own. It starts `claude -p` and `copilot -p` as subprocesses, so each person uses **their own** login, **only for themselves**. Forge does not offer a login, does not share credentials, and is meant as a local, personal tool. It does not store or print keys.

If `ANTHROPIC_API_KEY` is set in your environment, `claude` uses it instead of your login, and Forge warns you when that happens.

Your use of Claude Code and GitHub Copilot CLI is subject to their own terms. Check that your plan allows the way you use them: the arena makes several calls per task, so it spends your plan's limits faster.

### Isolation

By default `claude` runs isolated from your personal setup: only the target repository's `CLAUDE.md` is loaded, with no user settings, MCP servers, skills or auto memory. Set `claude.isolated: false` to turn this off. Two things cannot be isolated, because they come from the machine's managed policy and not from your own settings: organization-level instructions and managed plugins. Results can differ between machines because of them.

### Permissions

Read-only stages can only read. The Dev can edit files and run only the commands in `dev.allowed_commands`. `git push`, `rm`, `curl` and `wget` are denied on the `copilot` runner, and `bypassPermissions`, `--allow-all` and `--yolo` are never used.

## Where the prompts come from

The prompt of each stage lives in [`skills/`](skills/) as a `SKILL.md`, in the same format as Claude Code skills. Part of the text is adapted, with attribution, from three open source projects under the MIT license:

- [`mattpocock/skills`](https://github.com/mattpocock/skills), by Matt Pocock
- [`backnotprop/pstack`](https://github.com/backnotprop/pstack), by Lauren Tan
- [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills), by Addy Osmani

Their copyright notices and licenses are in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md). Each adapted skill names its origin in its frontmatter.

## Development

```sh
npm test            # unit tests, with a fake runner: no network, no cost
npm run typecheck
npm run lint
npm run test:manual # calls the real claude and copilot CLIs; needs both logged in
```

The design is in [`DESIGN.md`](DESIGN.md) and the build backlog in [`tasks.md`](tasks.md).

## License

[MIT](LICENSE)
