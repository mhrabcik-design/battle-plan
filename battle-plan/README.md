# Bitevní Plán — aplikace

React 19 + TypeScript + Vite PWA. Produkční base path je `/battle-plan/` a nasazení zajišťuje GitHub Actions.

## Požadavky

- Node.js 24 (stejná řada jako v CI)
- npm a přístup k závislostem z `package-lock.json`

## Příkazy

```powershell
npm ci
npm run dev
npm run lint
npm test
npm run build
```

`npm test` spouští současnou Node testovací sadu nad službami, synchronizací, autentizací, WorkLogs a diagnostikou. `npm run build` provede TypeScript build a produkční Vite/PWA bundle.

## Struktura

| Cesta | Role |
| --- | --- |
| `src/App.tsx` | Shell aplikace a skládání obrazovek |
| `src/components/` | Sdílené UI a WorkLogs komponenty |
| `src/hooks/` | Orchestrace hlasu, synchronizace a příkazů |
| `src/services/` | Gemini, Google API, Drive store, agent bridge a doménové služby |
| `src/db.ts` | Dexie schéma a doménové typy uložených dat |
| `src/utils/` | Čisté transformační a diagnostické funkce |
| `vite.config.ts` | PWA, base path a build identity |

## Konfigurace za běhu

Gemini API klíč a Google přihlášení se nastavují v aplikaci. Do repozitáře nepatří tokeny, klíče ani exporty uživatelských dat.

## Dokumentace

Produktový a technický kontext začíná v [../docs/README.md](../docs/README.md).
