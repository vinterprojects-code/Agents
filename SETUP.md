# Setup: agent team on GitHub (about 20 minutes)

## How it works
You open an issue with the `agent-task` label. GitHub Actions then runs the agents as a chain:

manager (plan) → developer (code) → qa (test) → developer-fix → qa-retest (only if QA fails) → manager (opens the pull request)

Each agent writes a file in `agent_handoff/`, and the next agent reads it. The workflow handles all git work, so agents can never push to `main`.
The dashboard reads the real job statuses from GitHub and animates each handoff.

## 1. Add the files
Copy everything in this folder into the root of your repo and push it:
- `.github/workflows/agent-team.yml` (the chain)
- `.github/actions/agent/action.yml` (runs one agent)
- `.github/ISSUE_TEMPLATE/task.md`
- `.claude/agents/manager.md`, `developer.md`, `qa.md`
- `CLAUDE.md` (fill in "Project context" first)
- `dashboard/` (the Agent Control Panel)

If you used the earlier kit, delete `.github/workflows/agents.yml` so two workflows don't run.

## 2. Install the Claude GitHub app
Open https://github.com/apps/claude and install it on the repo.

## 3. Add your Claude sign-in token
The team uses your Claude Pro or Max subscription, not an API key.
On your own computer, install Claude Code (`npm install -g @anthropic-ai/claude-code`), then run `claude setup-token`
and sign in with your claude.ai account. It prints a long-lived token.
Repo → Settings → Secrets and variables → Actions → New repository secret.
Name: `CLAUDE_CODE_OAUTH_TOKEN`. Paste the token there. Never paste it into a file or a chat.

## 4. Let Actions open pull requests
Repo → Settings → Actions → General → Workflow permissions:
- Choose "Read and write permissions"
- Tick "Allow GitHub Actions to create and approve pull requests"

## 5. Protect `main`
Repo → Settings → Branches → add a rule for `main`: require a pull request, block direct pushes.

## 6. Create the label
Repo → Issues → Labels → New label named exactly `agent-task`.

## 7. Watch your usage limits
Agent runs count against your Claude subscription's usage limits, the same as using Claude yourself.
One task runs 4 to 6 agent steps, each capped by `max_turns` in the workflow. If you hit the limit, jobs fail until it resets.

## 8. Try it
Open a new issue from the "Agent task" template with a tiny request (for example, add one line to the README).
Watch the Actions tab. After a few minutes you get a pull request, and the issue gets the manager's plan and a link to the PR.
To start a task on an existing issue, add the `agent-task` label, or run the workflow by hand with the issue number.

## 9. Open the control panel
Turn on GitHub Pages (Settings → Pages → Deploy from a branch → `main`, `/ (root)`), then open `https://OWNER.github.io/REPO/dashboard/`.
It needs a fine-grained token for the repo. The README section "Create the token" lists the exact permissions.

## If the manager needs an answer
The manager posts questions on the issue and the chain stops. Answer in a comment, then remove and re-add the `agent-task` label.

## Tuning
- `max_turns` per agent in `agent-team.yml` controls how long each agent can work.
- `allowed_tools` lists what each agent may run. Add your test commands there.
- Uncomment the PHP setup lines in the `developer` and `qa` jobs so tests can run.
- Only the repo owner can start the team. This is the `github.actor` check on the `manager` job.

## Good to know
- QA and the managers are read-only. If they change project files, the workflow reverts the change.
- If QA still fails after the fix round, the pull request opens as a draft with the failures listed.
- The chain and the control panel have been run end to end on a real repo. You may still need to add your own test commands to `allowed_tools`.
