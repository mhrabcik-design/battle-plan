---
title: PWA updates need explicit consent in every tab
date: 2026-09-25
category: ui-bugs
tags: [pwa, workbox, service-worker]
---

# PWA updates need explicit consent in every tab

`registerType: 'prompt'` alone only leaves a new service worker waiting; it does
not render an update prompt. Previously the generated registration script never
offered activation, so reloading with existing tabs open could retain the old app.

`PwaUpdatePrompt` now owns Workbox registration (`injectRegister: false`) and
offers an update or a persistent deferred reminder. Before activation it asks
the user to save edits and finish recording. Reload permission belongs to each
tab separately. If another tab activates the worker, a deferred tab retains its
in-memory work and reloads only after its own confirmation.

The direct Workbox API is intentional: the plugin's convenience React hook
reloads on `controlling` after observing an update, which does not preserve this
per-tab deferral contract.

A real two-tab production-preview test verified waiting, defer, activation,
preservation of unsaved state in the other tab, and its later explicit reload.
First rollout cannot retrofit this handler into already running old JavaScript:
close all old app tabs once to let the repaired version activate.
