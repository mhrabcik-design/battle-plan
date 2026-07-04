# AGENTS.md

> **For AI agents working in this repository.** Read this before implementing or debugging anything.

---

## Versioning

Every push to `main` triggers an automatic patch version bump in `package.json` (e.g. `4.3.6` → `4.3.7`), committed to `main` before the build step. The deployed app's Settings/About page shows the current version — this is the single source of truth for "what's running".

Major and minor bumps are done manually via a git tag:

```bash
git tag v5.0.0
git push origin v5.0.0
```

Tag pushes are detected by the deploy workflow and set `package.json` to the tag's version instead of incrementing patch.

The version is injected at build time via Vite `define` and consumed by `battle-plan/src/utils/buildInfo.ts` — no runtime API exists, the value is baked into the static `dist/` at deploy time.

---

## Rollback procedures

The user delegates git operations to the agent. When the user says "roll back" or "vrať se na verzi X", execute the matching recipe below. Always surface the git state (current commit, target commit, what was changed) before pushing. **Never force-push.**

### Recipe A: "Roll back one commit" (last change broke it)

For the common case: the most recent commit on `main` caused a regression.

```bash
# Verify the last commit is indeed the one to revert
git log -1 --stat

# Revert (no-edit means keep the default commit message)
git revert HEAD --no-edit

# Push — the auto-bump workflow will then run and deploy the reverted state
git push origin main
```

**When to use:** "Tohle se rozbilo, vrať to." or "rolni to o jedno zpět".

**Result:** The reverted code is on `main`. The deploy workflow auto-bumps the patch version (e.g. `4.3.7` → `4.3.8` if the regression commit was `4.3.7`) and deploys. The deployed app's Settings/About shows the new (post-revert) version within ~3 minutes.

### Recipe B: "Roll back to version X" (I know the version that worked)

For the precise case: the user has identified a specific version they want to return to.

```bash
# Find the commit where package.json was at the target version
git log --all --oneline -- battle-plan/package.json | head -20

# Identify the target commit (where the version matches X)
# Example: if you see "b7251bce chore(release): bump version to 4.3.5"
#         then 4.3.5 was the version after that commit
TARGET_SHA=$(git log --all --format="%H %s" -- battle-plan/package.json | \
  grep "bump version to 4.3.5" | \
  tail -1 | \
  awk '{print $1}')

# Revert all commits from TARGET_SHA+1 to HEAD, keeping the target state
git revert ${TARGET_SHA}..HEAD --no-commit

# Resolve any conflicts if they appear, then:
git add -A
git commit -m "chore(revert): roll back to 4.3.5"
git push origin main
```

**When to use:** "Vrať se na verzi 4.3.5" or "vrať to na verzi kde fungovalo přihlašování".

**Result:** The state at version X is on `main`. The deploy workflow auto-bumps the patch version and deploys.

### How to find the target version's commit

If the user names a version but you don't know the commit:

```bash
# List all version-bump commits, most recent first
git log --all --oneline --grep "bump version to" | head -20
```

The commit whose message ends with `bump version to 4.3.5` is the commit that SET the version to 4.3.5. Reverting from that commit+1 to HEAD gives you back to that state.

If the user has not named a specific version, ask: "Která verze fungovala?" or "Co fungovalo, než se to rozbilo?" before running Recipe B.

### Fallback: agent has no recipe

If the user asks for a rollback in a form that does not match Recipe A or B (e.g. "vrať to úplně, začni znovu"), ask: "Chceš revertnout poslední commit, nebo se vrátit na konkrétní verzi?" before proceeding.

---

## Knowledge store

Past solutions, bug patterns, and best practices are documented in `docs/solutions/`. Before starting work in an area that has documented solutions, read the relevant docs first. The directory is organized by problem type:

- `logic-errors/` — debugging logs and root-cause analyses
- `performance-issues/` — perf investigations
- `ui-bugs/` — interface and UX bugs
- `design-patterns/` — reusable patterns extracted from past work
- `architecture-patterns/` — architectural decisions and rationale
- `best-practices/` — workflow and process guidance
- `integration-issues/` — cross-system and integration patterns
- `database-issues/`, `security-issues/`, `test-failures/`, `runtime-errors/`, `build-errors/` — other error categories

When you solve a non-trivial problem, create a new doc in the appropriate category. The `ce-compound` workflow handles this — surface the problem, solution, and rationale.

---

## Codebase entry points

- **Source:** `battle-plan/src/` — React + Vite + TypeScript PWA
- **Build config:** `battle-plan/vite.config.ts` — defines `__APP_VERSION__`, `__BUILD_TIME__`, `__BUILD_COMMIT__`
- **Version display:** `battle-plan/src/utils/buildInfo.ts` — consumed by Settings/About
- **CI deploy:** `.github/workflows/deploy.yml` — auto-bump + build + deploy on push to main
- **Brainstorms:** `docs/brainstorms/` — product/feature brainstorming records
- **Plans:** `docs/plans/` — implementation plans
