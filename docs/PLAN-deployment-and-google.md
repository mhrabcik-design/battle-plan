# PLAN: Deployment, PWA & Google Integration

This plan covers the transition of Bitevní Plán from a local project to a live PWA with Google synchronization.

## Phase 1: PWA & Hosting Preparation
Goal: Make the app installable and deploy it to a secure HTTPS environment.

- **Task 1: PWA Manifest & Icons**
  - Create `public/manifest.json`.
  - Add icons (192x192, 512x512).
  - Update `index.html` with meta tags for theme color and mobile capability.
- **Task 2: Service Worker (Vite PWA Plugin)**
  - Install `vite-plugin-pwa`.
  - Configure it for "offline-first" in `vite.config.ts`.
- **Task 3: GitHub Deployment Setup**
  - User Action: Create GitHub account.
  - User Action: Create a repository named `battle-plan`.
  - Agent Action: Provide `git` commands to push the project.
  - Agent Action: Set up GitHub Actions for automatic deploy to GitHub Pages.

## Phase 2: Google Cloud Configuration
Goal: Prepare the "keys" for Calendar and Drive.

- **Task 4: Google Project Setup**
  - User Action: Create project at `console.cloud.google.com`.
  - User Action: Enable "Google Calendar API" and "Google Drive API".
  - User Action: Configure OAuth Consent Screen (Internal/Test).
  - User Action: Create OAuth 2.0 Client ID (Web Application).
  - *Note: Authorized JavaScript Origins must include the GitHub Pages URL.*

## Phase 3: Google Calendar Integration (Phase 4 of Roadmap)
Goal: Automatically send meetings to Google Calendar.

- **Task 5: OAuth Login Flow**
  - Add "Sign in with Google" button in Settings.
  - Implement token management (Google Identity Services).
- **Task 6: Automatic Sync Logic**
  - Implement `syncToCalendar(task)` function.
  - Logic: Trigger when AI identifies a `meeting` with a date/time.
- **Task 7: UI Feedback**
  - Show "Synced to Google" badge on meeting cards.

## Phase 4: Cloud Sync (Phase 5 of Roadmap)
Goal: Sync IndexedDB via Google Drive.

- **Task 8: Drive API Integration**
  - Use `appDataFolder` scope (secure, private app storage).
  - Implement full database export/import functionality locally first.
- **Task 9: Background Sync**
  - Periodically upload Dexie snapshot to Drive.
  - Check for remote updates on app startup.

## Verification Checklist
- [ ] App is installable on mobile (PWA prompt appears).
- [ ] App loads offline.
- [ ] User can sign in with Google.
- [ ] A meeting created in the app appears in Google Calendar within 5 seconds.
- [ ] Data is restored automatically after clearing browser cache (from Drive).
