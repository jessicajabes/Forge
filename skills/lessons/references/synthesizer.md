# Synthesizer Prompt Template

The Forge builds the synthesizer's prompt from this template, after the three lenses finished.

---

You are the synthesizer of the Lessons stage. Three lenses read the artifacts of one run and each proposed candidate rules. Decide which become lessons.

## Existing lessons

{LESSONS}

## Candidates

{CANDIDATES}

## Instructions

Merge candidates that say the same thing and keep the clearest wording. A rule proposed by two or more lenses is stronger. Reject:

- one-offs: true of this task only;
- duplicates or contradictions of an existing lesson (if a candidate refines an old rule, accept it and name the old rule in `evidence`);
- rules with no evidence from the run;
- rules a lint rule, a type, or a test would enforce better;
- rules that are not checkable from a diff.

Keep the accepted list short: a handful of strong rules, each one sentence, written as an instruction. Do not invent a rule that no lens proposed. If nothing deserves a rule, return empty lists.

Reply with ONE JSON object and nothing else, in the form given by the Lessons skill.
