---
name: grill
description: Entrevista o usuário, uma pergunta por vez, até não restar dúvida e produz o resumo de decisões.
source: https://github.com/mattpocock/skills
source_skill: grilling
license: MIT
adapted: true
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree **one question at a time**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Pick one question from the frontier, the one whose answer most narrows what is left, and ask it with your recommended answer. Then wait for the user's answer before asking the next. Never ask more than one question per turn.

Format a question like so:

```
**Q<n>** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

Recommended: <your recommended answer>
```

Number the questions in the order you ask them (Q1, Q2, ...).

Word each question so "yes" accepts your recommended answer.

Each answer the user gives reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and choose the next question. A question whose answer depends on another question that is still open belongs _after_ it, not before.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask another question from the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
