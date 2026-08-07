# Bitevní Plán

Produkční desktop-first PWA pro hlasové plánování úkolů, schůzek, myšlenek a odpracovaných činností. Aplikace běží z adresáře `battle-plan/`; zbytek repozitáře drží pouze aktuální dokumentaci a trvalé technické poznatky.

## Zdroj pravdy

- Produkční kód: `battle-plan/src/` na větvi `main`.
- Aktuální verze: `battle-plan/package.json`. Číslo verze se v dokumentaci neduplikuje.
- Datový model: `battle-plan/src/db.ts` (Dexie / IndexedDB).
- AI pravidla: `battle-plan/src/services/semanticEngine.ts`, `workLogExtractor.ts` a [AI manifest](docs/AI_MANIFEST.md).
- Build a deploy: `.github/workflows/deploy.yml`.

## Mapa repozitáře

| Cesta | Účel |
| --- | --- |
| `battle-plan/` | React + TypeScript + Vite PWA |
| `docs/PRODUCT.md` | Současný produktový kontrakt |
| `docs/ARCHITECTURE.md` | Architektura a datové toky |
| `docs/ROADMAP.md` | Otevřený backlog pro další etapu |
| `docs/USER_GUIDE.md` | Uživatelská příručka |
| `docs/AI_MANIFEST.md` | AI a datová pravidla |
| `docs/solutions/` | Trvalé poznatky z vyřešených problémů |
| `CONCEPTS.md` | Sdílený slovník projektu |

Podrobný rozcestník je v [docs/README.md](docs/README.md).

## Lokální práce

```powershell
cd battle-plan
npm ci
npm run dev
```

Před odevzdáním změny:

```powershell
npm run lint
npm test
npm run build
```

## Release

Push do `main` spustí GitHub Actions, automaticky zvýší patch verzi, provede kontrolní příkazy a nasadí GitHub Pages. Major nebo minor release se zahajuje tagem `vX.Y.Z`. Běžný lokální deploy přes historickou větev `gh-pages` se nepoužívá.

Viditelná verze, čas buildu a commit jsou do aplikace vložené při buildu a zobrazují se v Nastavení / Diagnostice.

## Pravidlo dokumentace

Git historie je archiv dokončených plánů a starých stavů. V repozitáři zůstává jen současný kontrakt, otevřená roadmapa a poznatky, které jsou stále užitečné. Aktivní implementační plán může dočasně vzniknout v `docs/plans/`, ale po dokončení se nemá stát druhým zdrojem pravdy.
