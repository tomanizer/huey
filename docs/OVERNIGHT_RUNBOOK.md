# Overnight autonomous run – Runbook

This runbook lets you start **one Cursor agent** that acts as orchestrator, implementer, and reviewer so it can work through the implementation plan **autonomously overnight** without prompting you. You review the results in the morning.

---

## Which approach to use

| Approach | Autonomy | Setup | Best for |
|----------|----------|--------|----------|
| **Single overnight agent (recommended)** | One Cursor Composer/Agent session runs all roles; works through the issue list until done or stopped | Paste one prompt, leave machine on | You want zero interaction until morning; you review PRs and progress then |
| **External scheduler + API** | True “run at 10pm, stop at 6am” | Requires script + OpenAI/Claude API (or similar) calling Cursor or another coding agent | You already have automation infra and want strict scheduling |

**Recommendation:** Use the **single overnight agent**. Cursor doesn’t run agents on a schedule by itself; a long-running Composer/Agent session is the way to get “work through the night” without building custom tooling. The agent follows the implementation order, implements each issue, opens PRs, reviews them, and merges (or leaves PRs open for you).

---

## Prerequisites (do these once)

1. **Repo state**
   - Default branch (e.g. `main`) is up to date.
   - GitHub issues exist (from `scripts/create-olap-issues.sh`).
   - You have push access to the repo (so the agent can create branches and open PRs).

2. **Machine**
   - **Prevent sleep** (Settings → Energy / Power → prevent display and system sleep while plugged in, or use `caffeinate` on macOS).
   - Leave Cursor open and the project (huey) loaded.

3. **Git**
   - No uncommitted changes (or commit/stash them) so the agent starts from a clean state.
   - Remote is correct (`origin` or your fork). Agent will push branches and open PRs to this remote.

4. **Optional but useful**
   - CI is green on `main` (so the agent isn’t blocked by existing failures).
   - You’ve read `docs/implementation-orchestration.md` so you know the issue order and reviewer rules.

---

## How to kick it off (step-by-step)

### Step 1: Close other Cursor chats (optional)

To avoid confusion, start a **new** Composer or Agent chat for the overnight run. You’ll paste the overnight prompt there.

### Step 2: Open the overnight prompt

Open this file in Cursor:

- **`docs/OVERNIGHT_PROMPT.md`**

(or copy its contents from below).

### Step 3: Start the agent

1. In Cursor, open **Composer** (Cmd+I or Ctrl+I) or the **Agent** panel.
2. **Paste the full contents of `docs/OVERNIGHT_PROMPT.md`** into the composer/agent input.
3. Add one line at the top with your choices (see “Customisation” below), for example:
   - `Auto-merge: yes` or `Auto-merge: no`
   - `Stop after: 5 issues` (optional cap)
4. Send the message (e.g. **Send** or **Run**).

### Step 4: Let it run

- Do **not** close the chat or put the machine to sleep.
- The agent will:
  - Read `docs/implementation-orchestration.md` and the implementation order.
  - For each issue in order: create branch → implement → open PR → run tests → act as reviewer → merge (if you allowed) or leave PR open.
  - Continue to the next issue until it hits your cap or the list is done.
- If something fails (e.g. CI red, merge conflict), the agent should either retry with fixes or stop and leave a short summary in the chat.

### Step 5: Morning review

1. **Check the Cursor chat** – Summary of what was done, any failures, and which PRs were merged or left open.
2. **Check GitHub** – **Pull requests** (open and merged) and **Issues** (closed vs open).
3. **Review open PRs** – If you set `Auto-merge: no`, review and merge (or request changes) yourself.
4. **Run the app and tests locally** – Spot-check the default branch and key flows.

---

## Customisation (add at top of the overnight prompt)

- **Auto-merge: yes** – Reviewer agent merges PRs when criteria are met (green CI, checklist satisfied). Use this for full autonomy.
- **Auto-merge: no** – Agent opens PRs and reviews them but does **not** merge; you merge in the morning. Safer if you want to review every change.
- **Stop after: N issues** – Cap how many issues to complete in one run (e.g. 5). Helps limit scope for the first night.
- **Start from issue #N** – Skip earlier issues (e.g. already done). Useful for subsequent nights.

---

## What to expect in the morning

- **Merged PRs** – Each has “Fixes #N” and corresponds to one issue. Check the diff and issue list.
- **Open PRs** – Either auto-merge was off or the agent left them for you (e.g. after a failure or by design).
- **Chat log** – Which issues were completed, which failed, and why (e.g. “CI failed on issue #7”, “Stopped after 5 issues”).

---

## If something goes wrong

- **Agent stopped mid-way** – Resume by starting a new chat with the same prompt and “Start from issue #N” set to the next open issue.
- **CI red on a PR** – In the morning, fix the failure locally (or ask the agent in a new chat to fix that PR), then merge.
- **Merge conflicts** – Agent may have reported them in the chat. Resolve on the branch, push, then merge or ask the agent to retry.
- **Machine slept** – Next time use `caffeinate` (macOS) or system settings to prevent sleep. For this run, restart with “Start from issue #N” and run again.

---

## Quick reference: file roles

| File | Purpose |
|------|--------|
| `docs/implementation-orchestration.md` | Implementation order, orchestrator and reviewer instructions (source of truth). |
| `docs/OVERNIGHT_PROMPT.md` | The single prompt you paste to start the overnight agent. |
| `docs/OVERNIGHT_RUNBOOK.md` | This runbook – prerequisites and kickoff steps. |
| `docs/ORCHESTRATOR_PROMPT.md` | Short orchestrator bootstrap (for manual or non-overnight use). |
