---
title: WorkLog Batch Voice Extraction With Person-Hours
date: 2026-06-30
category: docs/solutions/design-patterns
module: WorkLogs voice extraction
problem_type: design_pattern
component: assistant
severity: medium
applies_when:
  - User dictation can describe a period, repeated crew, or correction instead of one daily entry.
  - WorkLog reporting needs crew labor totals, not just elapsed clock hours.
  - A production deploy must be traceable to a visible app version.
tags: [worklogs, voice-extraction, person-hours, batch-review, release-versioning]
---

# WorkLog Batch Voice Extraction With Person-Hours

## Context

The `Prace` tab originally treated voice input as one WorkLog object with one date, one people string, and one hour total. That was too narrow for natural Czech dictation such as "minuly tyden na Plaza jsme byli kazdy den ja, Sergej a jeho bratr, 10 hodin denne; ve stredu jeste jeden clovek navic." The user expects that one utterance to become several reviewable daily records, with Wednesday corrected independently and with totals suitable for project reporting.

The same session also exposed a release-traceability problem: the deployed UI still showed an older version, making it hard to know whether the user was testing the intended GitHub Pages build. Session-history review reinforced that this was not just a code issue; the workflow needs visible version discipline around serious WorkLog changes.

## Guidance

Use a batch extraction envelope for WorkLog voice input instead of a single flat object. The envelope should carry proposed entries plus shared assumptions and confirmation reasons:

```ts
interface ExtractedWorkLogBatch {
  entries: ExtractedWorkLog[];
  assumptions: string[];
  needsConfirmation: boolean;
  confirmationReasons: string[];
}
```

Each proposed entry should remain compatible with the persisted WorkLog shape while adding optional calculation metadata:

```ts
interface WorkLog {
  hours: number; // reportable hours; batch voice uses person-hours
  hoursPerPerson?: number;
  peopleCount?: number;
  calculationNote?: string;
  assumptions?: string[];
  extractionBatchId?: string;
}
```

Keep relative-date and arithmetic logic in pure helpers so it can be tested without Gemini or UI state. The implemented helpers in `battle-plan/src/utils/workLogBatch.ts` cover prior workweek expansion, anonymous workers, person-hour calculation, and date-scoped corrections.

The confirmation UI must review a batch before writing anything. `WorkLogVoiceConfirm` should let the user edit, remove, and save individual rows, and the save path should write all accepted rows in one Dexie transaction with a shared `extractionBatchId`.

Validation should allow totals above 24 only when the number is explained as person-hours. The guard used by extraction, confirmation, and edit flows is:

```ts
hasExplainedPersonHours(totalHours, peopleCount, hoursPerPerson)
```

For release traceability, treat this kind of WorkLog capture change as a minor version bump. Update `battle-plan/package.json`, visible UI labels, and docs before pushing or deploying so GitHub Pages, mobile, and desktop views can be compared against the same version.

## Why This Matters

Natural work dictation is often relative and corrective. If the model is forced into a single WorkLog shape, it either drops days, merges corrections into the wrong date, or stores hours that no longer match reporting expectations.

Person-hours make the monthly and project totals meaningful for crew work. A three-person day at ten hours is thirty reportable hours, not ten. Storing the arithmetic metadata keeps the total auditable without exploding every worker into a separate row.

The explicit batch confirmation step keeps AI useful without making it silently authoritative. It is especially important when the extractor invents anonymous worker labels, resolves "ja" to Martin, or interprets "minuly tyden" as Monday through Friday.

Version discipline prevents a different class of bug: testing the wrong artifact. If the app still says `4.0.0` while the expected build is `4.2.0`, UI screenshots and user reports become ambiguous even when the code is correct.

## When to Apply

- Apply this pattern when one utterance can produce more than one WorkLog.
- Apply it when total hours may exceed a single person's daily hours because the value represents a crew total.
- Apply it when AI extraction relies on assumptions that should be visible before saving.
- Apply the version bump rule before any GitHub Pages deploy that changes WorkLog capture semantics.

## Examples

Input:

```text
Minuly tyden na projektu Plaza jsme byli kazdy den ja, Sergej a jeho bratr. 10 hodin denne. Ve stredu tam byl jeste jeden clovek navic.
```

Expected proposal shape:

```text
Mon, Tue, Thu, Fri: Martin, Sergej, Sergejuv bratr -> 3 x 10 h = 30 h
Wed: Martin, Sergej, Sergejuv bratr, Pracovnik 1 -> 4 x 10 h = 40 h
```

Verification added for this implementation:

- `node --experimental-strip-types src/services/workLogExtractor.test.ts`
- `tsc -b`
- focused `eslint` over the WorkLog extractor, batch helper, confirmation UI, voice bar, and card edit paths
- `vite build`

## Related

- Implementation commit: `78a7440 feat(worklogs): support batch person-hour extraction`
- Plan: `docs/plans/2026-06-30-001-feat-worklog-batch-extraction-plan.md`
- Prompt contract: `docs/AI_MANIFEST.md`
- WorkLog area guide: `docs/README.md`
- No older `docs/solutions/` entry covered this pattern at the time this learning was written.
