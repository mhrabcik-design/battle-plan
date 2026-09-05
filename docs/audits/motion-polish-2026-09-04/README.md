# Motion polish — 4. září 2026

## Výsledek

Zachováno rozložení a barevné role. Sdílené dialogy a boční panely mají oddělený backdrop a panel, vstup 200 ms a výstup 120 ms. Omezený pohyb používá pouze opacity (120/80 ms). Tři chybějící presence boundary nyní umožňují dokončit výstup. Primární tlačítka mají mírnější posun 1 px a stisk 98 %, přecházejí i CSS vlastnosti translate/scale. Disabled ovládání nemá tento pohyb.

## Skutečně pozorováno

- Lokální Battle Plan 4.3.64, aktuální pracovní zdroje, integrovaný prohlížeč, desktop 1424 × 1066 a mobil 390 × 844.
- Nastavení: otevření, fokus na zavření, Escape, návrat fokusu na KONFIGURACE, opakované otevření na mobilu. Dialog se vejde do obou viewportů.
- Práce: otevření a zavření inline formuláře bez uložení, přepnutí do kalendáře, srpen 2026, detail existujícího QA dne 21. srpna. Sheet je napravo, po Escape zmizí a fokus se vrátí na den.
- Konzole v ověřené relaci bez warning/error záznamů. Žádné datové operace ani přihlášení.
- Screenshoty uložené a vizuálně prohlédnuté: `01-settings-before.png`, `02-settings-after.png`, `03-sheet-after.png`, `04-mobile-settings.png`.

## Automatické ověření

- 7 nových testů: 4 kontrakty overlay motion, 3 CSS kontrakty; zachycené selhání před implementací, poté úspěch.
- Celá Node sada před review: 390/390 úspěšných testů (`npm test` deleguje na `test:worklogs`).
- ESLint, TypeScript + Vite produkční build a theme contract: úspěch. Build upozorňuje na existující velký chunk a kombinovaný static/dynamic import.
- Rozbitý uživatelský npm shim obejit přímým npm-cli.js z instalace Node; build potřeboval povolený běh mimo filesystem sandbox.

## Limity

Statické screenshoty nedokazují časový průběh animace. Reduced-motion emulace a hover/press nejsou v dostupném prohlížečovém API; tyto varianty jsou ověřeny helper/CSS kontrakty, nikoli vizuálním pozorováním. Diktování s AI, vnořené editace, všechna témata a všechny datové stavy nebyly v tomto cíleném průchodu testovány. Před merge doporučena ruční kontrola se systémovým omezením pohybu.

## Revize a finální browser pass

Revize správnosti, testů, projektových pravidel, frontend souběhu, adversariální revize a porovnání se staršími řešeními dokončeny. Dva revieweři a samostatný validátor potvrdili interaktivní odcházející panel; oprava přidává `useIsPresent`, `inert` a zákaz pointer events. Osm cílených testů a opakovaný build prošly. Test inert je zdrojový kontrakt, nikoli runtime důkaz dvojitého uložení.

Externí Claude revize byla zamítnuta před spuštěním; proběhla lokální náhradní adversariální revize. GitHub cíl ověřen přes API jako veřejný repozitář přihlášeného vlastníka s ADMIN přístupem.

Finální `ce-test-browser` pass: nový Vite server na `http://127.0.0.1:3001/battle-plan/`, stejný integrovaný browser. Resolver portu na Windows nesprávně označil obsazený 3000 jako volný; `--strictPort` zabránil kolizi a následný port 3001 byl úspěšný.

| Obrazovka / flow | Stav | Pozorování |
| --- | --- | --- |
| Plán / root | Pass | Správný název a prázdný stav bez chyb |
| Nastavení | Pass | Otevření, Escape, návrat fokusu; desktop/mobile dřívější pass |
| Anu příkazy | Pass | `/`, Escape, žádný zbylý dialog, fokus zpět; konzole bez error/warn |
| Práce / detail dne | Pass | Desktop sheet a fokus v implementačním passu před inert doplněním |
| Voice confirm a OAuth | Skip | Vyžaduje audio/AI nebo externí přihlášení |
| Focus editor | Skip | Na izolovaném serveru nejsou task data |
| Reduced-motion a exit double-submit | Skip | Chybí media/timing ovládání; pouze kontrakt a review |

Celkový výsledek browser auditu: PARTIAL, bez pozorovaných selhání, s uvedenými mezerami.

Závěrečné opakování po opravě z review: 391/391 testů, ESLint a theme contract úspěšné.
