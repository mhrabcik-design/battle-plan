---
title: Linear Main with Auto-Patch Versioning and Agent-Invocable Rollback
date: 2026-07-03
status: active
---

# Linear Main with Auto-Patch Versioning and Agent-Invocable Rollback

## Problem

The user is a solo developer working on a PWA from a single machine, switching between Codex and OpenCode. They have one concrete workflow gap:

- They want a fast, trackable signal that "the version running on the deployed site is the version I just committed". Today, `package.json` version `4.3.6` is not auto-bumped and is the only visible identifier in the app, so the user has no way to verify the deployed build matches a specific commit.
- They want an agent-invocable rollback: when they say "this broke it, roll it back", the agent handles the Git operation without the user needing to know the mechanics of `git revert`, `gh-pages`, or GitHub's PR revert button.

They explicitly do NOT want to manage branches, merge commits, or semantic version tags as a manual process. The mental model is "linear main, versioned, with an agent that does the operations".

## Why

The user has a recurring pattern: they make changes, commit to main, deploy runs via GitHub Actions, and the user wants to verify "what's running matches what I committed". Without an auto-bump, the version is decoupled from the commit history. Without a documented rollback procedure, every "this is broken" moment forces the user to either context-switch to GitHub UI or learn enough git/gh-pages to do it themselves. The user has explicitly delegated both operations to the agent.

## Goals

- Every commit to `main` increments the patch version in `package.json` automatically, with the new version visible in the app's settings/About page.
- Major and minor versions are bumped via a manual tag the user creates, not by editing `package.json` by hand.
- The user can say "rolni to o jedno zpět" and the agent knows what to do without asking the user how.
- The user can also say "vrať se na verzi 4.3.5" for a more precise rollback.
- The workflow requires zero Git UI interaction from the user for normal operation.
- A single GitHub Actions workflow handles both auto-bump and deploy.

## Non-Goals

- Branch-based feature workflow. The user is on `main` directly and wants to keep it that way.
- Automated changelog or release notes generation.
- Pre-release / RC / canary channels.
- Multi-environment deploys (staging, preview URLs). The user has one deploy target: `gh-pages`.
- Tags for every commit. Tags are reserved for major/minor releases and for "this is a known-good version" anchors.
- Cleanup of pre-existing stale `codex/*` and `feat/*` branches on origin. This is a separate concern; it would be done as a follow-up commit on `main` if the user wants it.

## Success Criteria

- After every merge to `main`, the deployed app's settings/About page shows a version number that is one patch higher than the previous deployed version, and a commit hash that matches the HEAD of `main` at the time of the merge.
- When the user says "rolni to o jedno zpět", the agent reverts the last commit on `main` and the deploy pipeline runs; the deployed app shows the previous version within the same workflow turn (modulo GitHub Actions duration).
- When the user says "vrať se na verzi 4.3.5", the agent finds the commit where `package.json` was at `4.3.5` (or the matching tag, if any), reverts all commits between that point and HEAD, and pushes. The deployed app shows `4.3.5` after deploy.
- The user never needs to open the GitHub web UI for any of these operations.
- `package.json` version never drifts from the actual deployed commit's version after the workflow lands.

## Approach

The system is built on three components:

### 1. Auto-bump on merge to main

A single GitHub Actions workflow (`.github/workflows/version-and-deploy.yml`) runs on every push to `main`:

1. Determine the current version from `package.json`.
2. Bump the patch segment (e.g. `4.3.6` → `4.3.7`).
3. Commit the version bump back to `main` with a message like `chore(release): bump version to 4.3.7`.
4. Build (`npm run build`) and deploy to `gh-pages` (existing `gh-pages -d dist` flow).
5. Skip the bump if the most recent commit on `main` is already a `chore(release): bump version to ...` commit (idempotency).

This is the "drobné změny" track. The user makes normal commits; the workflow auto-bumps and deploys.

### 2. Major/minor via tag

For a major (`5.0.0`) or minor (`4.4.0`) bump, the user runs locally:

```
git tag v5.0.0
git push origin v5.0.0
```

The workflow detects the new tag, updates `package.json` to the tag's version, commits, and deploys. Tags are anchors for "this is a known-good state".

### 3. Agent rollback procedure

Documented in a project instruction file (e.g. `AGENTS.md` once it exists, or in a dedicated `docs/workflow.md` for now). The procedure is two recipes:

**Recipe A: revert last commit**

```
git revert HEAD --no-edit
git push origin main
```

The auto-bump workflow then runs, and the deployed app shows the previous version.

**Recipe B: revert to a specific version**

```
git log --all --oneline -- package.json | head -50
git revert <commit-sha-of-target-version>..HEAD --no-commit
# Resolve any conflicts if they appear, then:
git commit -m 'chore(revert): roll back to <target-version>'
git push origin main
```

The user only needs to say "vrať se na verzi 4.3.5" to the agent; the agent runs Recipe B and reports what it did.

## Files

This brainstorm does not specify file-level implementation — the system touch surface is small and ce-plan should produce a focused implementation plan. Affected surfaces:
- `.github/workflows/` (existing `deploy.yml` may be replaced or extended)
- `package.json` (the version field becomes system-managed, not user-edited)
- A new project-instruction file documenting the agent's rollback recipes (where it lives is a planning decision: `AGENTS.md` if one is created, or a dedicated `docs/workflow.md` if not)
- The Battle Plan PWA's settings/About page (already shows version from `package.json`; needs no change, but a build hash display is a nice-to-have)

## Behavior

- Normal commit flow: user makes changes locally, commits to `main`, pushes. GitHub Actions auto-bumps patch, builds, deploys. User sees the new version in the app within ~2 minutes.
- Major/minor bump: user tags locally, pushes tag. GitHub Actions updates `package.json` to the tag's version, commits, deploys.
- "rolni to o jedno zpět": user says this to the agent. Agent runs Recipe A. The user watches the deploy logs and the app's version display reverts.
- "vrať se na verzi 4.3.5": user says this to the agent. Agent runs Recipe B, asking for confirmation if the target is far back (more than 5 commits) or if conflicts are likely.
- Agent must surface the resulting git state to the user before pushing. Never force-push.
- "Jakou verzi teď mám nasazenou?" → user asks the agent. Agent runs `git log --oneline gh-pages -1` and `git show gh-pages:package.json | grep version` and reports.

## Edge Cases

- **Two parallel merges to main**: GitHub Actions serializes workflow runs per push. The auto-bump commit is itself a commit on main, so the next push sees the bumped version. No race conditions expected in single-developer workflow, but the workflow must be re-runnable safely.
- **The last commit is the auto-bump itself**: Idempotency check in step 5 prevents infinite loops.
- **Reverting the auto-bump commit itself**: Works correctly; the next commit on main triggers a fresh auto-bump.
- **No commits on main for a long time**: Patch version doesn't change. App shows the same version. This is correct behavior, not a bug.
- **User pushes a tag with the same version that's already in `package.json`**: Workflow skips the bump and re-deploys. Acceptable behavior; the user gets a redeploy of the same version.
- **A revert introduces a merge conflict in `package.json`**: Agent stops and asks the user how to resolve. Default resolution: keep the new version (the one being reverted to) and report what it did.

## Dependencies and Assumptions

- **A1.** The user is the only person pushing to `main`. No branch protection rules that would require reviews before merge.
- **A2.** The GitHub Actions workflow has write permission to `main` (it commits the version bump). This requires either a `GITHUB_TOKEN` with `contents: write` permission or a PAT.
- **A3.** The `gh-pages` branch is the deploy target and continues to work as before. The current `deploy.yml` is replaced or extended, not duplicated.
- **A4.** The user has a working `package.json` build that produces a deployable artifact in `dist/`. The current `vite build` configuration is sufficient.
- **A5.** The user's mental model of "version" aligns with the displayed value in `package.json` (semver). If the user has a different versioning convention in mind, this brainstorm needs revision.

## Open Questions

- **Q1.** Should the auto-bump workflow also create a git tag on every release (e.g. `v4.3.7`), or only on user-pushed tags? **Default proposal: only on user-pushed tags.** Auto-tags would clutter the tag namespace; the commit message + linear history is enough for the user's stated needs.
- **Q2.** Should the in-app version display also show a short commit hash (e.g. `4.3.7+abc1234`)? **Default proposal: yes**, with the hash derived at build time via `git rev-parse --short HEAD` and injected as a build-time env var. This makes "what's running" verifiable at a glance.
- **Q3.** How should the agent detect which instruction file to read for the rollback recipe? **Default proposal: the recipe lives in `docs/workflow.md` (or `AGENTS.md` if one is created in this same session).** The agent reads it on demand. If neither exists, the agent falls back to a documented default procedure and surfaces a "this could be saved as a project instruction file" reminder.
- **Q4.** When the user says "vrať se na verzi 4.3.5" but no commit exists at that version (e.g. the version was never tagged and `package.json` was edited manually before the workflow landed), how does the agent find the right commit? **Default proposal: the agent searches `git log --all --oneline -- package.json` for the commit that introduced `4.3.5` to `package.json`, and asks the user to confirm if the most recent match is older than 6 months or 50 commits.**

## Out of Scope (deferred)

- Stale `codex/*` and `feat/*` branches on origin. Cleanup is a separate task.
- Pre-existing `package.json` versions that don't correspond to actual deploys. The user can manually align `package.json` once at the start of this workflow if they want a clean baseline.
- A web-based "rollback" UI. The user explicitly delegated to the agent; the user talks to the agent, not the web.
- Multi-user or multi-machine workflows. The user is solo and on one machine; assumptions are explicit.

## Origin

- This brainstorm came out of a session where the user completed a feature (the "quiet Google auth for Drive sync" change) and realized during the PR/merge phase that they didn't have a version-rollback workflow. The pain was real: `package.json` was at `4.3.6` with no way to know what was deployed.
