# F6 Verification Report — Battle-Plan Pracovní činnosti

**Datum:** 2026-06-29
**Fáze:** F6 — Drive sync (workLogs + projects)
**Ověřoval:** Hermes (Anu profil, default)

## Výsledek: ✅ PASSED

| Vrstva | Příkaz | Výsledek | Timestamp |
|---|---|---|---|
| 1. TypeScript | `npx tsc --noEmit` | ✅ exit=0 | 2026-06-29 08:50 UTC |
| 2. Build | `npm run build` | ✅ exit=0, `built in 5.28s`, 645.63 KiB precache | 2026-06-29 08:50 UTC |
| 3. Runtime (ad-hoc) | `tsx /tmp/hermes-verify-f6-merge-logic.mjs` | ✅ **21/21** testů prošlo | 2026-06-29 08:50 UTC |

## Soubory změněné v F6

| Soubor | Typ | Řádků | Účel |
|---|---|---|---|
| `src/services/workLogsSync.ts` | **rozšířen** | +130 | `mergeCloudToLocal()`, `mergeLocalToCloud()`, `MergeResult` interface |
| `src/App.tsx` | upraven | +50 | WorkLogs sync v `checkSync` + auto-backup useEffect na `workLogsDataHash` |

## Sync architektura

```
1. Mount / visibilitychange → checkSync()
   ├── workLogsSync.init() → najdi /Anu-BattlePlan/ složku
   ├── workLogsSync.loadAll() → { workLogs, projects, timestamp }
   └── mergeCloudToLocal(cloudWorkLogs, cloudProjects)
       ├── workLogs: composite key = date+projectName+people → winner-wins podle updatedAt
       └── projects: match podle name.toLowerCase() → winner-wins podle updatedAt

2. Změna v db.workLogs / db.projects → workLogsDataHash useMemo změní hodnotu
   → setTimeout 10s → mergeLocalToCloud()
   └── workLogsSync.saveAll({ workLogs, projects }) → multipart PATCH do work_logs_data.json
```

## Testy (21 celkem, všechny prošly)

### WorkLog merge (10 testů)
- ✅ Cloud-only workLog → add
- ✅ Cloud newer → update (hours=9, updatedAt=T(0))
- ✅ Cloud older → no-op (hours=9 unchanged)
- ✅ Různé people → nový záznam (composite key match)
- ✅ Local data preserved across merges
- ✅ Idempotent re-run (žádné duplicity)

### Project merge (9 testů)
- ✅ Cloud-only project → add
- ✅ Color change (stejné jméno) → update
- ✅ Soft-delete (isActive=false) → update
- ✅ Nové jméno → add
- ✅ Empty merge → 0 changes

### Edge cases (2 testy)
- ✅ Composite key uniqueness (hours se může měnit, nebere se v úvahu)
- ✅ Merge result statistics (added/updated counters)

## Známé limitace (F6 scope)

- **Rename projektu nefunguje přes merge** — match je podle `name.toLowerCase()`, ne podle clientId UUID. TODO F7+ přidá `clientId` pole do Project/WorkLog.
- **Composite key pro WorkLog** = date+projectName+people — dva záznamy se stejným dnem/projektem/lidmi seberou jako jeden. TODO F7+ UUID.
- **mergeLocalToCloud vyžaduje GAPI init** → v Node bez okna se nedá otestovat.

## ⚠️ Co NEPROŠLO suite-style verifikací

- V projektu není `npm test` → **ad-hoc, ne „suite green"**
- Reálný Drive upload/download se neověřil (vyžaduje Google OAuth token + browser)

## Trvalé auditní soubory

| Cesta | Účel |
|---|---|
| `/tmp/hermes-verify-f6-merge-logic.mjs` | Zdrojový ověřovací skript |
| `/tmp/hermes-verify-f6-result.json` | JSON report s výsledky |
| `/tmp/hermes-verify-f6/` | Sandbox (node_modules + run.mjs) |
| `/home/martin/projects/battle-plan/battle-plan/docs/F6-verification-report.md` | Tento report (přežije `/tmp` cleanup) |

## Status

**F6 ověřeno ✅.** Připravený pokračovat na F7 (Anu reporting worker).