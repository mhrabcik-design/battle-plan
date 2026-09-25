---
title: Keep device credentials out of task backups
date: 2026-09-25
category: security-issues
tags: [drive, backup, credentials, allowlist]
---

# Keep device credentials out of task backups

Task backups formerly serialized all settings, including `gemini_api_key`, and
hydration restored those settings into another device. Restrict cloud settings to
the explicit portable preferences `gemini_model` and valid positive `ui_scale`.
Unknown future settings are excluded by default.

The same allowlist applies when observing the backup revision, publishing or
reading a Drive payload, and hydrating settings. Changing a local key therefore
does not trigger an upload and an old cloud key cannot overwrite the local key.
Local settings and manual local exports are separate boundaries.

This prevents new task backups from carrying credentials. It does not erase
historical Drive backups or revoke an already copied key. An owner whose actual
key was previously backed up should rotate it and remove obsolete secret-bearing
copies according to their retention needs. No live credentials are used in tests.
