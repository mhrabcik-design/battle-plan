# Bitevni Plan App

React + TypeScript + Vite aplikace pro projekt Bitevni Plan.

## Stack

- React 19
- TypeScript
- Vite 7
- Tailwind CSS 4
- Dexie / IndexedDB
- Google Gemini REST API
- Google Drive, Tasks a Calendar API
- Vite PWA

## Aktualni moduly

- `Plán`, `Týden`, `Úkoly`, `Schůzky`, `Myšlenky`
- `Práce` (`worklogs`) pro projekty, lidi, hodiny a pracovní popisy
- `Návrhy` (`suggestions`) pro schvalování návrhů od Anu

## Lokalne spusteni

```powershell
npm install
npm run dev
```

## Overeni produkcniho buildu

```powershell
npm run build
```

## Nasazeni

Projekt je pripraveny pro GitHub Pages s base path `/battle-plan/`.

```powershell
npm run deploy
```

## Dokumentace

Hlavni dokumentacni index je v [../docs/README.md](../docs/README.md). Tento README popisuje pouze technicky vstup do aplikace.
