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
| `dashboard/` | Agent Control Panel: run the team, review and merge from the browser |
| `SETUP.md` | Manual setup steps |
| `START_HERE.md` | Instructions for Claude Code to set everything up |

## Start a task
- From the control panel: **+ New task** (see below).
- From the GitHub app: Issues → New → "Agent task" → describe what you want → Submit.

## Agent Control Panel
Open https://vinterprojects-code.github.io/Agents/dashboard/ (GitHub Pages, served from `main`).
It is a static page that calls the GitHub API straight from your browser. From it you can:
- see each agent's live status, current task, progress and last step (refreshes every 10 seconds while the tab is open)
- pause or resume the team, stop a run, and message an agent on its current task
- create tasks (title, details, starting agent, priority), and see them on a board: Pending, In progress, In review, Done
- comment on, close and reopen tasks, or start the team on a task again
- review pull requests: diff, before/after view, checks and the QA verdict, then merge (squash, deletes the branch), request changes, or close

### Create the token (once per browser)
1. Open [GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token](https://github.com/settings/personal-access-tokens/new).
2. Name it, for example "Agent Control Panel", and pick an expiry.
3. **Repository access:** Only select repositories → this repo.
4. **Repository permissions:**
   - Actions: **Read and write** (agent status, Pause/Resume, Stop, Run the team)
   - Contents: **Read and write** (before/after view, merging, deleting the merged branch)
   - Issues: **Read and write** (tasks, comments, labels, close/reopen)
   - Pull requests: **Read and write** (reviews, request changes, close)
   - Commit statuses: **Read-only**, and Checks: **Read-only** if it is listed (check results)
   - Metadata: Read-only (added automatically)
5. Generate the token, open the control panel, paste it, and press **Connect**.

The token is stored only in that browser's localStorage and is sent only to `api.github.com`. Never paste it into a file, an issue or a chat. **Settings → Disconnect** removes it. If it expires, the panel asks for a new one.

Only the repo owner can act from the panel. Anyone else who connects gets a read-only view. Comments from other people are labelled, and the agents ignore them.

Notes:
- All three agents run in one workflow, so **Pause** pauses the whole team (it turns the "Agent team" workflow off). A run already in progress keeps going unless you press **Stop**.
- Starting agent **Developer** skips planning: the issue text becomes the plan. QA can't start a task, because it tests the developer's work.
- The QA verdict is posted on each agent pull request as an "Agent QA" status. Merge is disabled while any check fails or the branch has conflicts.

## Set up
Open this folder in Claude Code and say: `Read START_HERE.md and follow it.`
Prefer to do it by hand? Follow `SETUP.md`.

Hello from the agent team: we're up and working happily on your tasks! 👋

This repo is managed from the Agent Control Panel.
