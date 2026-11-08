# START HERE (instructions for Claude Code)

You are setting up a new GitHub repository called **VinterAiAgents** from the files in this folder, then making its
agent team work through GitHub Actions. The owner is Prince (Vinter Projects). Work through the steps in order.
Be concise. After each step, say in one line what happened. Ask me only when a step says to.

## What this folder is
An AI agent team (manager, developer, QA) that runs as a chain of GitHub Actions jobs.
Read `README.md`, `CLAUDE.md`, `.github/workflows/agent-team.yml`, and `.github/actions/agent/action.yml` first so you understand it.
Do not redesign it. Only fix things that are actually broken.

## Rules
- Never ask me to paste a secret or API key into this chat, and never write one to any file.
- Never force-push. Never merge pull requests yourself.
- If a command fails, read the error, fix the cause, and retry. If you are stuck after 3 attempts on one step, stop and tell me exactly what is wrong.
- If something can't be automated, tell me the exact manual steps and wait for me to say it's done.

## Step 1: Check tools
Run `git --version` and `gh auth status`.
- If `gh` is missing or not logged in, tell me to run `gh auth login` and wait.
- Pushing workflow files needs the `workflow` scope. If `gh auth status` doesn't show it, tell me to run `gh auth refresh -s workflow` and wait.

## Step 2: Create the repository
1. Ask me one question: should the repo be private (recommended) or public? Default to private.
2. Initialise git on branch `main`, commit everything with the message `Add Vinter agent team`.
3. Create the repo and push: `gh repo create VinterAiAgents --private --source=. --remote=origin --push`
   (use `--public` if I chose public). If the name is taken, use `VinterAiAgents-Team` and tell me.
4. Note the OWNER/REPO name for later steps.

## Step 3: Label and Actions settings
1. Create the label: `gh label create agent-task --color 5319E7 --description "Starts the agent team" --repo OWNER/REPO`
2. Let Actions write and open pull requests:
   `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -f default_workflow_permissions=write -F can_approve_pull_request_reviews=true`
3. Try to protect `main` so changes need a pull request (use branch protection or a ruleset through `gh api`).
   If GitHub says this needs a paid plan for private repos, tell me in one line and move on. The workflow never pushes to `main` anyway.

## Step 4: Secrets and the Claude GitHub app (manual, I do these)
1. Tell me to run this in my own terminal and paste my key when prompted, so it never appears in this chat:
   `gh secret set ANTHROPIC_API_KEY --repo OWNER/REPO`
   Wait for me to confirm, then check with `gh secret list --repo OWNER/REPO`.
2. Tell me to open https://github.com/apps/claude and install the app on this repo only. Wait for me to confirm.

## Step 5: Fill in the project context
Ask me one question: what will this repo's agents mainly work on (for example "PrestaShop modules in PHP")?
Update the "Project context" section of `CLAUDE.md` with my answer, the stack, and how to run tests if I know it.
If the work is PHP, uncomment the `setup-php` and `composer install` lines in the `developer`, `qa`, `developer-fix`, and `qa-retest` jobs of `agent-team.yml`.
Commit these changes on a branch named `setup/project-context` and open a pull request. Tell me the link and wait for me to merge it.

## Step 6: Test the chain end to end
1. Create a tiny test issue as the owner:
   `gh issue create --repo OWNER/REPO --label agent-task --title "Test: add a line to the README" --body "Add one friendly line at the end of README.md saying the agent team is working."`
2. Watch it: `gh run list --workflow agent-team.yml --repo OWNER/REPO`, then `gh run watch <run-id> --repo OWNER/REPO`.
   Expected: manager, developer, qa (and developer-fix and qa-retest only if QA fails), then finalize opens a pull request.
3. If a job fails: `gh run view <run-id> --log-failed`, find the cause, fix the workflow or action files on a branch, open a pull request,
   and after I merge it re-run with `gh workflow run agent-team.yml -f issue=<number>`.
   Common causes to check first: the Claude GitHub app not installed, the secret missing or misnamed, `--allowedTools` blocking a command,
   an `if:` condition skipping a job, and the artifact download step finding nothing on the first job.
4. When a pull request appears, show me its link and the QA verdict. Do not merge it.

## Step 7: Report
Finish with a short summary:
- The repo URL and visibility
- What passed in the test run and what I still need to do by hand
- How I start a task from my phone: open an issue from the "Agent task" template in the GitHub app
- How to use the team in another repo: copy `.github/`, `.claude/`, and `CLAUDE.md` into it, then add the secret and install the app there
- How to use `dashboard/index.html` (see `SETUP.md`, step 9)
Ask whether I want the repo marked as a template (`gh repo edit --template`) so new project repos can start from it.
