# Agent team rules

This repo is worked on by three agents defined in `.claude/agents/`: **manager**, **developer**, and **qa**.
The owner gives a task by opening a GitHub issue with the `agent-task` label. A GitHub Actions workflow
(`.github/workflows/agent-team.yml`) runs the agents one after another and hands work from one to the next
through files in the `agent_handoff/` folder.

## Project context (edit this)

- What this repo is: The Vinter Projects agent team (manager, developer, QA) and the general/mixed tasks given to it. No single product stack yet.
- Stack and versions: Not fixed yet. Markdown, YAML (GitHub Actions) and a static HTML dashboard (`dashboard/index.html`). Match whatever stack an issue is about.
- How to run tests: No test suite yet. Check changed files by hand (for example, valid YAML, the dashboard opening in a browser) and say what you checked.
- Coding standards: Keep changes small and match the existing style of the file you edit.

## The chain

1. **manager** reads `agent_handoff/issue.md` and writes `plan.md`: goal, acceptance criteria, files likely to change, risks.
   If the request is unclear or risky, the first line of `plan.md` is `NEEDS_INPUT:` followed by questions, and the chain stops.
2. **developer** implements the plan by editing repo files and writes `dev-notes-1.md`.
3. **qa** tests against the acceptance criteria and writes `qa-report-1.md`. The last line is `VERDICT: PASS` or `VERDICT: FAIL`.
4. If QA fails, **developer** fixes the root causes (`dev-notes-2.md`) and **qa** re-tests (`qa-report-2.md`). One fix round only.
5. **manager** writes `pr.md`. The workflow then opens the pull request (as a draft if QA did not pass).

## Hard rules

- The workflow handles git. Never run git commands, push, or open pull requests yourself.
- Never read, print, or edit secrets, `.env` files, API keys, or payment and credential settings.
- Never delete files or data unless the issue explicitly asks for it.
- Keep changes minimal and on-topic. Put unrelated ideas under Follow-ups instead of doing them.
- If tests can't run, say so plainly. Never claim tests passed without running them.
- Write your output file exactly where the workflow tells you, in `agent_handoff/`.
