---
title: Split Agent-Native Audit Recommendations Into Mainline-Verified PRs
date: 2026-07-06
category: workflow-issues
module: Agent-native audit recommendation delivery
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A CE or agent-native audit returns multiple independent recommendations"
  - "A recommendation wave spans UI, assistant prompts, sync, and tooling fixes"
  - "Each recommendation can be planned, reviewed, merged, and verified independently"
  - "Node tests run TypeScript directly with --experimental-strip-types"
  - "A final integration fix is needed after several mainline merges"
tags:
  - agent-native-audit
  - recommendation-wave
  - small-prs
  - mainline-merges
  - verification
  - node-strip-types
  - explicit-imports
  - ce-workflow
---

# Split Agent-Native Audit Recommendations Into Mainline-Verified PRs

## Context

A CE / agent-native audit can return several useful recommendations at once. Treating the whole audit as one implementation branch makes review, rollback, and verification ambiguous when the recommendations touch different surfaces: background polling, Google/Drive sync, project and suggestion UI, assistant prompt context, task normalization, and onboarding/capability discovery.

The 2026-07-06 audit wave used a safer delivery shape:

- PR #19 created implementation plans for the remaining audit recommendations.
- PRs #20-#24 implemented discrete recommendation slices against `main`.
- PR #25 fixed the one post-merge integration failure as a narrow follow-up.
- The release chain ended at `4.3.33`, making the landed state visible through the app version.

The final follow-up exposed a tooling-specific lesson. `battle-plan/package.json` runs service tests directly through Node with native TypeScript stripping:

```json
"test:worklogs": "node --import fake-indexeddb/auto --experimental-strip-types src/services/workLogExtractor.test.ts && ..."
```

That runner is not Vite. It needs import specifiers Node can resolve. The post-merge fix in `battle-plan/src/services/appContext.ts` used an explicit `.ts` import:

```ts
import { db, type Project, type Setting, type WorkLog } from '../db.ts';
```

## Guidance

### Start broad audit waves with a plan PR

When an audit returns several independent recommendations, land one documentation/planning PR first. The plan PR should name the recommendation numbers, source files, boundaries, verification gates, and deferred work. That gives each later implementation PR a small contract instead of one sprawling branch.

In this wave, PR #19 created plans for:

- agent bridge polling cadence,
- Google Task Lists wiring,
- project and suggestion delete UI,
- app context injection into AI prompts,
- prompt-native task normalization,
- agent capability discovery.

### Implement one recommendation slice per PR

Keep each implementation PR narrow enough that its risk and rollback path are obvious.

Observed slices:

- PR #20: `useDriveSyncOrchestration` task-list wiring.
- PR #21: project/suggestion delete affordances and Drive JSON deletion.
- PR #22: `appContext.ts` and prompt context injection.
- PR #23: `taskNormalization.ts` helper extraction and prompt sanitization rules.
- PR #24: onboarding, Anu self-description, capability hints, and slash palette.
- PR #25: explicit `../db.ts` import for Node direct-test resolution.

### Merge through `main` between slices

Use `main` as the integration checkpoint. Once a slice is merged, start the next slice from the actual deployed/releasable state instead of from a speculative stack of local branches. This matters in this repo because pushes to `main` auto-bump the patch version; each merge becomes traceable in Settings/About and in GitHub Actions.

If a narrow failure appears after a merge, fix it as its own PR. PR #25 is the model: it did not reopen the whole app-context branch or change the test runner; it changed the import that Node could not resolve and verified the current mainline state.

### Verify each slice with layered gates

Use gates that catch different failure classes:

- `npx tsc -b` or `npm run build` for TypeScript/API drift.
- `npm run test:worklogs` for service behavior under Node, fake IndexedDB, and direct `.ts` execution.
- `npm run lint` for static code quality, while explicitly calling out pre-existing warnings.
- `npm run build` for Vite/bundler integration.
- Browser/manual smoke for UI-facing slices.

Observed PR verification in this wave included:

```text
PR #20: tsc -b clean; npm run test:worklogs 102/102 pass
PR #21: tsc -b clean; npm run test:worklogs 102/102 pass; npm run lint 0 errors
PR #22: tsc -b clean; npm run test:worklogs 67/67 pass
PR #23: tsc -b clean; npm run test:worklogs 102/102 pass; npm run lint 0 errors
PR #24: tsc -b clean; npm run test:worklogs 106/106 pass; npm run lint; npm run build
PR #25: tsc -b clean; npm run test:worklogs 107/107 pass; npm run lint; npm run build
```

For UI work, do not treat typecheck/service tests as sufficient. This wave additionally smoke-tested the capability-discovery UI through Vite preview: the Diagnostics page showed the `JSEM ANU` card, the `/` slash palette opened and closed with Escape, and the mic hint contained the new capability copy.

### Keep direct Node TypeScript tests explicit about extensions

When a service module is exercised by `node --experimental-strip-types`, use explicit `.ts` specifiers at that boundary:

```ts
// Good for direct Node .ts execution
import { db } from '../db.ts';
const { googleService } = await import('./googleService.ts');
```

Avoid fixing resolver failures by weakening the test, hiding it behind a bundler, or changing the whole test runner. The direct runner is useful precisely because it catches resolver drift that Vite can mask.

Browser/Vite-only code can still follow the existing app convention where appropriate. The explicit-extension rule applies to service/test paths that Node executes directly.

## Why This Matters

Small PRs keep a recommendation wave reviewable. Reviewers can reason about one slice, verify one risk class, and revert one merge if needed. A broad all-in branch hides integration failures until the end, when the fix surface is larger and the deploy version is harder to interpret.

Mainline-first merging turns integration into a repeated checkpoint instead of a final surprise. In this wave, the direct Node resolver failure appeared after app-context work had been integrated. Because the previous slices were already merged and verified, the correct fix was a one-line import correction in `appContext.ts`, not a broad branch rewrite.

Layered verification prevents false confidence:

- TypeScript can pass while Node direct execution fails on import resolution.
- Service tests can pass while a UI affordance is invisible or wired to the wrong path.
- Vite can resolve imports that Node direct tests cannot.
- Lint/build success does not prove first-run onboarding or slash-command keyboard behavior.

The explicit `.ts` import convention preserves the lightweight direct service-test architecture. It keeps tests close to Node semantics and avoids adding a bundler layer just to paper over import-specifier mistakes.

## When to Apply

Apply this pattern when:

- A CE review, code review, or agent-native audit produces multiple independent recommendations.
- The recommendations span assistant behavior, sync/integration code, UI affordances, and tooling.
- Each recommendation can be planned, implemented, reviewed, and verified independently.
- The repo runs `.ts` service tests directly with Node and `--experimental-strip-types`.
- A UI-facing change lacks full automated browser coverage and needs smoke evidence.
- A post-merge failure is narrow enough to fix as a focused follow-up PR against `main`.

Do not use this pattern to justify slicing one atomic behavior across many PRs. If the user-visible contract only works when all parts land together, keep it in one PR and make the verification cover the full path.

## Examples

### Plan PR before implementation PRs

PR #19 was documentation-only. It captured scope and verification for the six remaining recommendations before implementation started. This made later PRs easier to review because each one could reference its plan instead of renegotiating scope in the code diff.

### Small sync wiring PR

PR #20 wired `googleService.getTaskLists()` into `useDriveSyncOrchestration.checkSync`. The task-list fetch stayed in a narrow `try/catch`, updated `setGoogleTaskLists(lists)`, and fell back to `[]` without blocking Drive sync. The verification was limited and appropriate: typecheck plus `test:worklogs`.

### UI affordance PR with service boundary

PR #21 added user-driven delete behavior across UI and storage:

- `ProjectPicker.tsx` soft-deletes projects after confirmation.
- `suggestionsSync.ts` deletes a suggestion and matching replies from Drive JSON.
- `SuggestionsPage.tsx` removes deleted suggestions from local UI state.

This is UI-facing work, so static gates are not enough. The plan required visible delete-path smoke in addition to typecheck, tests, and lint.

### App-context prompt injection followed by a focused resolver fix

PR #22 introduced `appContext.ts` and threaded app state into assistant prompts. PR #25 then fixed Node direct-test resolution by making the Dexie import explicit:

```ts
import { db, type Project, type Setting, type WorkLog } from '../db.ts';
```

That fix stayed local to the resolver failure. It did not change `test:worklogs`, hide the service behind Vite, or broaden the app-context scope.

### Prompt-native normalization with TypeScript safety nets

PR #23 extracted `taskNormalization.ts` and moved high-level sanitization rules into `semanticEngine.ts` prompt text. The durable pattern is not “delete defensive code”; it is “put semantic rules where the model reads them, then keep narrow TypeScript clamps as a safety net.” When doing this kind of extraction, also update tests around the new invariant rather than trusting old passing assertions.

### Capability discovery needs browser smoke

PR #24 added onboarding, the `JSEM ANU` self-description card, capability hints, and `SlashCommandPalette.tsx`. Service tests can cover dismissal state and persistence, but they cannot prove the user sees the card, the `/` key listener opens the palette outside inputs, or Escape closes it. A browser smoke check is the right gate for those behaviors.

## Related

- `docs/solutions/best-practices/helper-extraction-test-rewriting-2026-07-04.md` — related to rec 7 helper extraction and test-contract discipline.
- `docs/solutions/design-patterns/worklog-batch-person-hour-extraction.md` — related precedent for visible release/version traceability and multi-command verification evidence.
- `docs/solutions/integration-issues/google-tasks-scope-403-background-fetch-2026-07-06.md` — related to optional Google Tasks behavior and rec 8 sync wiring.
- `docs/solutions/integration-issues/drive-readiness-diagnostic-states-2026-07-05.md` — related Drive-backed service diagnostic context.
- `docs/solutions/integration-issues/ensure-fresh-token-refresh-dedup-2026-07-04.md` — relevant when new sync/polling paths introduce additional Google calls.
