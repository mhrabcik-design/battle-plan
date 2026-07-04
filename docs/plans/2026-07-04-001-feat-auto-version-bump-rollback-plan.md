---
title: Auto-Patch Version Bump on Deploy + Agent Rollback Recipes
type: feat
status: active
date: 2026-07-04
origin: docs/brainstorms/2026-07-03-linear-main-auto-version-rollback-requirements.md
---

# Auto-Patch Version Bump on Deploy + Agent Rollback Recipes

## Summary

Add a version-bump step to the existing GitHub Actions deploy workflow so every push to `main` auto-increments the patch version in `package.json` before building. Document two rollback recipes in `AGENTS.md` so the agent can execute "roll back one commit" or "roll back to version X" without the user touching git.

---

## Problem Frame

The user is a solo developer who deploys a PWA to GitHub Pages. The app already displays version + commit SHA via `buildInfo.ts` (which reads from Vite's `define` at build time). The gap is that `package.json` version (`4.3.6`) never auto-increments, so the displayed version is stale and the user cannot verify which version is actually deployed. Additionally, there is no documented rollback procedure — the user delegates git operations to the agent but the agent has no recipe to follow.

---

## Requirements

- **R1.** Every push to `main` triggers an automatic patch-version bump in `package.json` (e.g. `4.3.6` → `4.3.7`), committed back to `main` before the build step.
- **R2.** The bump is idempotent: if the most recent commit is already a `chore(release): bump version to X` commit, the workflow skips the bump.
- **R3.** Major/minor version bumps are done manually via git tag (e.g. `git tag v5.0.0 && git push origin v5.0.0`); the workflow detects the tag and sets `package.json` to the tag's version instead of bumping patch.
- **R4.** Two rollback recipes are documented in `AGENTS.md`:
  - Recipe A: revert the last commit on `main` (`git revert HEAD --no-edit && git push`)
  - Recipe B: revert to a specific version (find the commit where `package.json` had that version, revert all commits since, push)
- **R5.** The existing in-app version display (`buildInfo.ts` → Settings/About) continues to work unchanged — it already reads from Vite's `define` which reads from `package.json`.

---

## Scope Boundaries

- No branch-based feature workflow. Single linear `main`.
- No automated changelog or release notes.
- No pre-release / canary channels.
- No multi-environment deploys. One target: GitHub Pages.
- No cleanup of stale `codex/*` branches (separate task).
- The `predeploy` / `deploy` npm scripts in `package.json` (which use `gh-pages -d dist`) are legacy — the CI uses `actions/deploy-pages@v4`. The legacy scripts are left in place but are not part of this plan.

---

## Context & Research

### Relevant Code and Patterns

- `.github/workflows/deploy.yml` — existing CI workflow: checkout → npm ci → lint → build → upload artifact → deploy-pages. Runs on push to `main`.
- `battle-plan/vite.config.ts` — reads `package.json` version via `import packageJson from './package.json'` and injects as `__APP_VERSION__`. Also injects `__BUILD_TIME__` and `__BUILD_COMMIT__` (from `GITHUB_SHA`).
- `battle-plan/src/utils/buildInfo.ts` — exports `buildInfo` object with version, buildTime, commit, origin, channel. Already consumed by Settings/About UI.
- No `AGENTS.md` or `CLAUDE.md` exists in the repo. The rollback recipes will be the first content.

---

## Key Technical Decisions

- **Bump happens inside CI, not via pre-commit hook.** A pre-commit hook would require the user to install it locally; CI is the single source of truth for what deploys. The tradeoff is that the version-bump commit appears on `main` after the triggering push, creating a two-commit sequence (user's commit + bump commit). This is acceptable for a solo developer.
- **The bump commit uses `GITHUB_TOKEN` with `contents: write`.** The existing workflow already has `permissions: contents: read`; this needs to be upgraded to `contents: write` so the bump commit can be pushed back.
- **Tag-triggered major/minor bump uses a separate workflow trigger.** The deploy workflow triggers on `push: branches: ["main"]`; tag pushes trigger `on: push: tags: ["v*"]`. The tag workflow updates `package.json` to the tag version, commits to `main`, and the main-push workflow then builds and deploys.
- **`AGENTS.md` is the home for rollback recipes.** It's the standard discovery point for agent instructions. Creating it also benefits future compound-engineering runs (the Discoverability Check will find it).

---

## Implementation Units

### U1. Auto-bump patch version in deploy workflow

**Goal:** Every push to `main` that is not itself a version-bump commit triggers a patch-version increment in `package.json`, committed back to `main` before the build step runs.

**Requirements:** R1, R2, R3.

**Dependencies:** None.

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `battle-plan/package.json` (only the `version` field at runtime; no manual edits)

**Approach:**
- Add a new first job `bump-version` to the deploy workflow that runs before `build`.
- The job reads the current version from `battle-plan/package.json`, checks if the last commit message starts with `chore(release): bump version to`, and if not, bumps the patch segment.
- The bumped `package.json` is committed back to `main` with message `chore(release): bump version to X.Y.Z`.
- The `build` job then checks out the updated `main` (with the bump commit) and proceeds as today.
- For tag-triggered major/minor bumps: add `on: push: tags: ["v*"]` to the workflow. When triggered by a tag, the bump-version job sets `package.json` to the tag version instead of incrementing patch.

**Test scenarios:**
- Happy path — push a normal commit to `main`; workflow bumps patch from `4.3.6` to `4.3.7`, commits, builds, deploys. App shows `4.3.7`.
- Idempotency — push a `chore(release): bump version to 4.3.7` commit; workflow detects the prefix and skips the bump. No infinite loop.
- Tag trigger — push tag `v4.4.0`; workflow sets `package.json` to `4.4.0`, commits to `main`, deploys. App shows `4.4.0`.
- Edge case — two rapid pushes to main; GitHub Actions serializes the workflow runs via the existing `concurrency: group: "pages"` setting; the second run sees the first run's bump commit and skips.

**Verification:**
- Push a test commit to `main`. Verify the deployed app's Settings/About page shows a version one patch higher than before.
- Push a `chore(release): bump version to X` commit manually; verify no double-bump.

---

### U2. Document rollback recipes in AGENTS.md

**Goal:** Create `AGENTS.md` with two rollback recipes so the agent can execute them when the user says "roll back" or "go back to version X".

**Requirements:** R4.

**Dependencies:** U1 (the auto-bump must be in place so that after a revert, the next deploy auto-bumps correctly).

**Files:**
- Create: `AGENTS.md` (repo root)

**Approach:**
- `AGENTS.md` contains:
  1. A brief description of the versioning system (auto-patch on main push, manual tag for major/minor).
  2. **Recipe A: "Roll back one commit"** — `git revert HEAD --no-edit && git push origin main`. The deploy workflow then auto-bumps and deploys the reverted state.
  3. **Recipe B: "Roll back to version X"** — search `git log --all --oneline -- battle-plan/package.json` for the commit that set version X, then `git revert <target-sha>..HEAD --no-commit` (or `git revert <target-sha>..HEAD` for individual reverts), resolve conflicts, commit, push.
  4. A note on when to use which recipe: A for "last change broke it", B for "I know the version that worked".
  5. The `docs/solutions/` knowledge-store mention (per ce-compound's Discoverability Check).

**Test scenarios:**
- Test expectation: none — this is documentation, not behavior-bearing code. Verification is manual: read the file and confirm the recipes are executable.

**Verification:**
- Say "roll back one commit" to the agent in a future session. The agent reads `AGENTS.md`, executes Recipe A, and reports the result. The deployed app shows the previous version.

---

## System-Wide Impact

- **Interaction graph:** The deploy workflow now writes to `main` (via the bump commit). The existing `concurrency: group: "pages"` setting prevents parallel workflow runs from racing.
- **Error propagation:** If the bump step fails (e.g. npm script error, git push permission denied), the workflow aborts before build/deploy. The user sees a failed Actions run in GitHub.
- **State lifecycle risks:** The bump commit is pushed to `main` during CI. If the user is simultaneously pushing to `main` locally, there could be a push race. Mitigation: the `concurrency` setting serializes runs; the user (solo developer) is unlikely to push during a CI run.
- **API surface parity:** No API changes. The in-app version display is unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `GITHUB_TOKEN` lacks `contents: write` permission | Set `permissions: contents: write` in the workflow YAML |
| Bump commit triggers another workflow run (infinite loop) | Idempotency check: skip bump if last commit message starts with `chore(release): bump version to` |
| User pushes locally while CI is running | `concurrency: group: "pages"` serializes; solo developer is unlikely to race |
| Tag push and main push race | Tags are rare (major/minor only); acceptable risk |

---

## Post-Deploy Monitoring & Validation

- After the first deploy with the new workflow: verify the app's Settings/About page shows a version one higher than `4.3.6` (i.e. `4.3.7` or higher).
- After saying "roll back one commit" to the agent: verify the deployed version matches the expected previous version within ~3 minutes (GitHub Actions duration).
- Validation window: 3 days. Owner: `@mhrabcik-design`.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-03-linear-main-auto-version-rollback-requirements.md](../brainstorms/2026-07-03-linear-main-auto-version-rollback-requirements.md)
- Existing deploy workflow: `.github/workflows/deploy.yml`
- Build-time version injection: `battle-plan/vite.config.ts` (`define` block)
- In-app version display: `battle-plan/src/utils/buildInfo.ts`
