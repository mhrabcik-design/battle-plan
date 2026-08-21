---
title: Responsive surface and motion system for dense planning UI
date: 2026-08-21
category: design-patterns
module: BattlePlan interaction surfaces
problem_type: design_pattern
component: frontend
severity: medium
applies_when:
  - Dense cards must keep actions inside their own visual boundary at narrow widths.
  - Calendar items support pointer and keyboard rescheduling.
  - Several editors and dialogs need consistent focus, Escape, and motion behavior.
tags: [responsive-ui, motion, task-cards, drag-and-drop, overlays, accessibility]
---

# Responsive surface and motion system for dense planning UI

## Context

Task cards, meeting blocks, weekly-calendar items, and editors had evolved independently. Controls could compete with content or appear outside a card at narrow widths, broad transitions made interactions feel inconsistent, overlapping calendar items obscured one another, and each overlay owned a slightly different keyboard and focus lifecycle.

## Guidance

Treat every interactive fragment as a bounded surface with an explicit layout, state, and motion contract:

- Let card content determine its own responsive layout. The task list uses an auto-fitting grid, while each task card is a CSS container whose action rail changes layout when the card itself becomes narrow.
- Keep primary controls in normal document flow and give icon-only actions an accessible name and a minimum touch target. Do not rely on hover to reveal the only route to an action.
- Derive visual tone from one semantic precedence rule. Urgent state wins over completion, which wins over the underlying task type.
- Use a small set of motion durations and explicit properties. Respect `prefers-reduced-motion` globally through `MotionConfig` and CSS fallbacks.
- During pointer drag, render the ghost imperatively and commit only the semantic result. Snap to the scheduling grid, announce meaningful target changes, cancel safely when geometry or visibility changes, and skip persistence for a no-op drop.
- Lay out overlapping timed items in deterministic columns, then switch to compact or summary density as available width shrinks.
- Route modal, sheet, and command-palette behavior through one overlay primitive that owns the portal, topmost Escape handling, focus trap and return, inert background, scroll lock, and entry/exit motion.
- Treat local persistence as the editor success boundary. If optional remote synchronization fails afterward, close the editor and surface a non-blocking warning rather than implying that the local save failed.

The main implementation anchors are `battle-plan/src/index.css`, `battle-plan/src/components/ui/OverlaySurface.tsx`, `battle-plan/src/components/TaskCard.tsx`, `battle-plan/src/components/WeeklyCalendar.tsx`, and `battle-plan/src/hooks/useTaskCommands.ts`.

## Why This Matters

The visual system stays coherent because the same semantic states produce the same boundaries and motion, while container-based layout prevents page-width assumptions from leaking into reusable cards. Separating transient pointer rendering from persisted schedule changes also keeps drag feedback smooth without turning every pixel into React state or a database write. The shared overlay boundary removes competing Escape handlers and makes focus behavior predictable across every editor.

## When to Apply

- When adding a new task-like card, calendar block, inline editor, modal, or bottom sheet.
- When a control is clipped, detached from its content, available only on hover, or too small for touch.
- When a drag interaction changes persisted scheduling data.
- When a new overlay needs keyboard dismissal or focus management.

## Examples

Prefer semantic and bounded layout helpers over page-level exceptions:

```tsx
const tone = getTaskVisualTone(task);

<article className="task-card" data-tone={tone}>
  <div className="task-action-rail">…</div>
</article>
```

Keep schedule calculation pure and save only after the interaction resolves:

```ts
const patch = getWeeklyReschedulePatch(task, targetDate, targetMinute);
if (!isWeeklyScheduleNoop(task, patch)) await onReschedule(task, patch);
```

## Related

- `docs/solutions/design-patterns/weekly-task-history-and-rescheduling.md`
- `docs/plans/2026-08-21-2157-feat-visual-interaction-polish-plan.md`
