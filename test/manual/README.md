# Manual tests

These tests call the real `claude` and `copilot` CLIs. They need both installed and logged in, and they spend the quota of your plan. They are not part of `npm test`.

## CLI smoke tests

```sh
npm run test:manual
```

Each file ends in `.manual.ts`. They check that a real read-only call returns text, reads the target repository's `CLAUDE.md` (Claude), and cannot write files.

## Reference task (T27)

`experiment.py` runs one reference task in one configuration, in a throwaway copy of a public repository, and prints its metrics as JSON:

```sh
npm run build
python3 test/manual/experiment.py --task is-number --config arena    # forge-jj, Dev in arena (3 candidates)
python3 test/manual/experiment.py --task is-number --config simple   # forge-jj, plain Dev
python3 test/manual/experiment.py --task is-number --config direct   # one `claude -p` call, no Forge
python3 test/manual/experiment.py --task is-number --config arena --dry-run
```

- The Grill is answered by the script (`chega`, then `sim`), so the interview is as short as it can be and the spec is thin.
- The cost is relative: the number of model calls and the size of what went in and out, read from `calls.jsonl` in the run folder. The CLIs do not report real cost.
- Nothing is pushed anywhere. Raw results are in `results/`; the reading of them is in `results.md`.
