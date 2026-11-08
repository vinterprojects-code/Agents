# VinterAiAgents

An AI agent team that works through GitHub: a **manager**, a **developer**, and a **QA** agent that pass tasks to each other.

Open an issue with the `agent-task` label and the team runs as a chain of GitHub Actions jobs:

manager (plan) → developer (code) → qa (test) → developer-fix → qa-retest (only if QA fails) → manager (opens the pull request)

Every task becomes a branch and a pull request, so GitHub keeps the full history. The agents never push to `main`. You merge.

## Files
| Path | What it does |
| --- | --- |
| `.github/workflows/agent-team.yml` | The chain of jobs |
| `.github/actions/agent/action.yml` | Runs one agent and hands its work to the next |
| `.github/ISSUE_TEMPLATE/task.md` | The "new task" form |
| `.claude/agents/*.md` | The manager, developer, and QA instructions |
| `CLAUDE.md` | Team rules and project context |
| `dashboard/index.html` | Live view of the chain, with animated handoffs |
| `SETUP.md` | Manual setup steps |
| `START_HERE.md` | Instructions for Claude Code to set everything up |

## Start a task
From the GitHub app: Issues → New → "Agent task" → describe what you want → Submit.

## Set up
Open this folder in Claude Code and say: `Read START_HERE.md and follow it.`
Prefer to do it by hand? Follow `SETUP.md`.

Hello from the agent team: we're up and working happily on your tasks! 👋

This repo is managed from the Agent Control Panel.
