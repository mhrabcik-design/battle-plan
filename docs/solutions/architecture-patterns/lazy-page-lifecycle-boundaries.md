---
title: Lazy Page Lifecycle Boundaries
date: 2026-08-07
category: architecture-patterns
module: lazy_page_lifecycle
problem_type: architecture_pattern
component: frontend_stimulus
severity: high
applies_when:
  - A secondary React page is loaded with React.lazy and Suspense
  - A lazy page owns resources such as a microphone, timer, subscription, or sync controller
  - A rejected dynamic import must fail locally without taking down the application shell
related_components:
  - service_object
tags:
  - react-lazy
  - suspense
  - error-boundary
  - resource-ownership
  - lifecycle-boundary
---

# Lazy Page Lifecycle Boundaries

## Context

BattlePlan loads Suggestions, WorkLogs, and Diagnostics as module-scoped lazy components (`battle-plan/src/App.tsx:42-44`). The selected view can therefore change before the corresponding page has mounted. During that interval, `Suspense` renders a shared pending state (`battle-plan/src/App.tsx:64-68`, `battle-plan/src/App.tsx:663-705`).

WorkLogs adds a second lifecycle to that route transition. `WorkLogVoiceBar` publishes its controller only after it mounts and clears it on unmount (`battle-plan/src/components/worklogs/WorkLogVoiceBar.tsx:142-147`). The route can already be `worklogs` while that controller is legitimately still `null` (`battle-plan/src/App.tsx:500-505`).

This extends the existing voice-lifecycle rule: navigation and unmount are resource transitions, not merely presentation changes. The prior WorkLog learning documents the same principle for proposal cancellation and recorder cleanup (`docs/solutions/ui-bugs/worklog-voice-proposal-cancel-reopen.md`).

## Guidance

Treat a lazy secondary page as an explicit boundary with separate ownership for selection, pending, failure, and domain resources.

1. Derive domain ownership from the selected route, not from controller truthiness. A controller is a temporarily available capability; it is not the ownership signal.
2. Let `Suspense` own only the pending state while the import is unresolved.
3. Put an error boundary outside `Suspense` so a rejected import replaces only the failed page subtree with recovery UI (`battle-plan/src/components/PageErrorBoundary.tsx:13-50`).
4. When the selected domain's controller is not ready, fail closed. Disable the shared action and guard its handler so it cannot fall through to another domain (`battle-plan/src/App.tsx:500-505`, `battle-plan/src/App.tsx:809-830`).
5. Use a full reload after a rejected module-scoped dynamic import. Clearing boundary state alone can render the same lazy object and its rejected loader again; reloading creates a new module-loader lifecycle (`battle-plan/src/components/PageErrorBoundary.tsx:24-49`).

## Why This Matters

Controller readiness and domain ownership diverge as soon as a page becomes lazy. Before `WorkLogVoiceBar` mounts, its registration effect cannot publish a controller, but the floating microphone already belongs to the persistent shell. If `null` meant "not WorkLogs," a click during that window could start the shell's general recorder. Once the page mounted, the same button would switch to a different recorder controller and leave the first recording without its expected controls.

Pending and rejected imports also require different user experiences. A loader is appropriate while React is waiting; a rejected chunk is terminal for that module instance and needs an explicit recovery action. `Suspense` and an error boundary are complementary rather than interchangeable.

This separation keeps responsibilities stable:

- the route decides which domain may receive a shared command;
- the controller supplies the selected domain's live capability and state;
- `Suspense` renders pending UI;
- the error boundary contains failed page loading;
- the resource hook cleans up streams, timers, and buffers on lifecycle exit (`battle-plan/src/hooks/useAudioRecorder.ts:182-210`).

## When to Apply

Use this pattern when a dynamically imported route or tab owns state that a persistent shell control delegates to. Typical examples include microphones, cameras, keyboard shortcuts, editors, polling controls, and imperative save or submit handlers.

It is especially important when a missing page-local controller could otherwise fall through to a valid controller from another domain. Treat that absence as "owner selected, capability not ready," not as permission to choose a fallback owner.

## Examples

Derive ownership first, then readiness:

```tsx
const isWorkLogVoiceMode = viewMode === 'worklogs';
const controller = isWorkLogVoiceMode ? workLogVoiceController : null;

const micDisabled = isWorkLogVoiceMode
  ? !controller || controller.disabled
  : isProcessing;
```

Guard the command before any fallback path:

```tsx
if (isWorkLogVoiceMode) {
  if (!controller) return;
  await controller.toggle();
  return;
}
```

Compose pending and rejected states explicitly:

```tsx
<PageErrorBoundary resetKey={viewMode}>
  <Suspense fallback={pageFallback}>
    <WorkLogsPage onVoiceControllerChange={setWorkLogVoiceController} />
  </Suspense>
</PageErrorBoundary>
```

The local architecture branch was verified with 113 tests plus TypeScript and ESLint. That is evidence for the reviewed branch state, not a claim that the change is merged or deployed.

## Related

- `docs/solutions/ui-bugs/worklog-voice-proposal-cancel-reopen.md` explains why WorkLog cancel, navigation, and unmount are terminal voice lifecycle events.
- `docs/solutions/best-practices/helper-extraction-test-rewriting-2026-07-04.md` covers testing state transitions and async resource cleanup after boundaries are extracted.
- `battle-plan/src/components/worklogs/WorkLogVoiceBar.tsx:19-24` defines the page-local voice controller contract.
- `battle-plan/src/components/PageErrorBoundary.tsx:13-50` implements page-scoped rejected-load recovery.
