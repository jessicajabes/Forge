# Reference task results (T27)

Measured on 2026-10-19 and 2026-10-20, with Claude Code 2.1.304, the default model, and the Forge at commit `c9d4b3a` (`results/` has the raw numbers).

## What was measured

One task on one project, by decision of the author (the design asked for 2 or 3 projects):

- **Project:** [`jonschlinkert/is-number`](https://github.com/jonschlinkert/is-number), MIT, 13 files, 111 tests that run in under a second.
- **Task:** "Make `isNumber` return false for hexadecimal, octal and binary strings such as `'0x1A'`, `'0b11'` and `'0o7'`, while decimal and exponent strings such as `'12'`, `'-1.5'` and `'1e3'` stay valid. Add tests for both groups."
- **Configurations:** `direct` is one `claude -p` call. `simple` and `arena` are `forge-jj` complete runs (`--review final`), with `--no-arena` and with 3 candidates.

## Results

| Configuration | Time | Model calls | Prompt chars | Review cycles | Tests pass | Committed | Diff |
|---|---|---|---|---|---|---|---|
| Claude direct | 86 s | 1 | n/a | n/a | yes (120) | n/a | 2 files, +12 −2 |
| Forge, plain Dev (first run, old review rule) | 776 s | 14 | 181,556 | 3 of 3, **escalated** | yes | **no** | 2 files, +14 −2 |
| Forge, plain Dev (new review rule) | 876 s | 17 | 193,700 | 3 of 3, approved | yes (123) | yes | 2 files, +17 −2 |
| Forge, Dev in arena | 808 s | 20 | 226,782 | 2 of 3, approved | yes (120) | yes | 2 files, +16 −3 |

All four versions solve the task and pass the tests. The code is equivalent: a guard on the `0x`, `0b` and `0o` prefixes (the direct and plain versions also accept a sign, which JavaScript does not parse as hex anyway). In the arena, the three candidates converged on the same shape and the judge called it a tie in practice.

## What it showed

1. **The Forge costs 10 to 15 times the model calls of plain Claude for this task, and about 10 times the time.** The whole flow (Grill, Recon, Tasks, review, lessons) dominates, not the Dev.
2. **The arena added about 18% to the plain Forge run** (20 calls against 17, 17% more prompt text), not the 4 to 5 times the design estimated for the Dev stage alone. The Dev is a small part of the total.
3. **No difference in quality was visible.** The arena and the plain Dev produced equivalent code. One task cannot tell them apart.
4. **The first plain run exposed a real flaw in the review.** The code was right from cycle 1, but the reviewer kept raising small points (a case not tested, a double `trim()` that the lead had already dismissed). Under the old rule any open `consider` item blocked the batch, so after 3 cycles nothing was committed. The rule now approves at the cycle limit when only `consider` items are left (DESIGN 6.1), and the second run closed the batch.
5. **The reviewers only read.** Nobody runs the tests during the review; one reviewer noted that in the smoke test. Dev results are only as verified as the Dev made them.

## Limits of this measurement

- One project, one task, one run of each configuration. Review is a model, so a second run could go differently.
- The Grill was answered with `chega`: the spec is thin, so this does not measure the value of the interview.
- The arena was run with the same model for every candidate (`dev.arena.models` unset) and the judge on the same runner. The diversity of models, which the design counts on, was not tried.
- Cost is relative (calls and characters). Real cost and the effect on the plan's limits were not measured.
- Only small tasks. An arena may matter more on tasks where a single attempt tends to take a wrong shape.

## Decision

Pending the author: keep the arena as the default, or turn it off by default and keep `--arena <n>`.
