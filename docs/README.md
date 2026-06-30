# Dokumentace projektu Bitevni Plan

Tento soubor je zdroj pravdy pro orientaci v dokumentaci. Starsi plany zustavaji v repozitari kvuli historii rozhodnuti, ale aktualni zadani a stav se cte odsud, ze `zadani.md`, `navod.md`, `logika_zaznamu.md` a `docs/AI_MANIFEST.md`.

## Kanonicke dokumenty

| Soubor | Role | Stav |
| --- | --- | --- |
| `../README.md` | Vstupni rozcestnik repozitare | Aktualni |
| `../zadani.md` | Souhrn produktu, dokoncenych fazi a aktualni roadmapy | Aktualni |
| `../navod.md` | Uzivatelska prirucka | Aktualni |
| `../logika_zaznamu.md` | Pravidla AI zpracovani zaznamu | Aktualni |
| `AI_MANIFEST.md` | Detailni AI kontrakt pro prompt a datove mapovani | Aktualni |
| `../FUTURE_PLANS.md` | Backlog dalsiho rozvoje | Aktualni backlog |
| `../battle-plan/docs/F5-verification-report.md` | Overeni hlasove extrakce pracovnich cinnosti | Auditni report |
| `../battle-plan/docs/F6-verification-report.md` | Overeni Drive sync pro workLogs/projects | Auditni report |

## Soucasny produktovy kontrakt

Bitevni Plan je osobni planovaci PWA pro rychle hlasove zachyceni prace. Hlavni zpusob pouziti je diktat do AI, ktera vytvori nebo aktualizuje strukturovany zaznam v IndexedDB.

Zaznamy maji ctyri hlavni produktove oblasti:

- `task`: ukol s deadline, urgentnosti `1 | 2 | 3`, podukoly, pokrokem a kapacitnim varovanim.
- `meeting`: schuzka s datem, casem, delkou a volitelnou synchronizaci do Google Calendar.
- `thought`: myslenka, kde AI muze aktivne rozvijet souvislosti a navrhovat dalsi kroky.
- `workLogs`: pracovni cinnosti v zalozce Prace, vazane na projekty, lidi, hodiny, datum a popis.

Vedle toho existuje integracni oblast `suggestions`: navrhy od Anu z Drive souboru, ktere uzivatel schvaluje, upravuje nebo zamita.

Klicove aktualni principy:

- evropsky 24h casovy format ve vsech vstupech a vystupech,
- deadline-centric logika pro ukoly,
- tydenni timeline 7:00-19:00,
- Focus Mode pro detailni editaci,
- Prace jako samostatna evidence realne odpracovanych hodin, oddelena od ukolu a schuzek,
- hlasovy vstup v Praci s potvrzovacim dialogem pred ulozenim,
- konzervativni filtrovani zaznamu, ktere vypadaji jako schuze/jednani, aby nezkreslovaly soucty hodin,
- timestamp-based sync, kde novejsi zmena vyhrava,
- REST Gemini workflow misto historicky zkousene Gemini Live/WebSocket cesty.

## Technicky stav

| Oblast | Aktualni rozhodnuti |
| --- | --- |
| Aplikace | `battle-plan/`, React + TypeScript + Vite |
| Verze | `4.2.1` |
| UI | desktop-first office rozhrani, responzivni mobilni PWA |
| AI modely v kodu | `gemini-3-flash-preview` jako default; dale `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-pro` |
| Audio | REST API, normalizace audio blobu na podporovany inline audio format; WorkLogs maji vlastni extractor |
| Data | Dexie schema v8, soft delete u tasku, `updatedAt` pro merge, `projects` a `workLogs` pro Praci |
| Google | OAuth, Drive backup/restore, Tasks, Calendar, `/Anu-BattlePlan/` slozka |
| Drive soubory | `battle_plan_data.json`, `work_logs_data.json`, agent/suggestions soubory podle integrace Anu |

## Release a verzovani

Kazdy deploy na GitHub Pages musi byt dohledatelny podle viditelne verze v aplikaci.

Verzovani pouziva format `major.minor.patch`:

- `patch` (`4.1.1`) pro drobne opravy, UI texty, deploy fixy a bezpecne lokalni zmeny bez nove produktove oblasti.
- `minor` (`4.2.0`) pro nove funkce nebo vyznamne rozsireni existujici oblasti, napr. dalsi modul Prace nebo reporting.
- `major` (`5.0.0`) pro zasadni produktovou etapu, zmenu datoveho modelu s migraci, nebo chovani, ktere meni zpusob pouzivani aplikace.

Release disciplina:

1. Pred produkcnim deployem zvedni verzi v `battle-plan/package.json`.
2. Viditelna verze v UI musi odpovidat `package.json`; nema zustat natvrdo stary text.
3. Po buildu nasad `battle-plan/dist` na `gh-pages`; samotny push do `main` neaktualizuje web `mhrabcik-design.github.io/battle-plan/`.
4. V commitu nebo souhrnu udelej jasne, jaka verze je nasazena a co se v ni zmenilo.

## Aktualni modul Prace

Zalozka `Prace` (`viewMode: worklogs`) je aktualni jadro verze 4.2.1.

| Cast | Soubor |
| --- | --- |
| Stranka | `battle-plan/src/pages/WorkLogsPage.tsx` |
| Manualni formular | `battle-plan/src/components/worklogs/WorkLogForm.tsx` |
| Hlasovy vstup | `battle-plan/src/components/worklogs/WorkLogVoiceBar.tsx` |
| Potvrzeni AI extrakce | `battle-plan/src/components/worklogs/WorkLogVoiceConfirm.tsx` |
| Karty / tabulka / kalendar | `battle-plan/src/components/worklogs/WorkLogCard.tsx`, `WorkLogTable.tsx`, `WorkLogCalendar.tsx` |
| Projekty | `battle-plan/src/components/worklogs/ProjectPicker.tsx`, `Project` v `battle-plan/src/db.ts` |
| AI extrakce | `battle-plan/src/services/workLogExtractor.ts` |
| Drive sync | `battle-plan/src/services/workLogsSync.ts` |
| Meeting filtr | `battle-plan/src/utils/workLogFilter.ts` |

Soucasne hranice Prace:

- WorkLog reprezentuje odpracovanou cinnost, ne schuzku.
- Projekt je povinny; kdyz AI nerozpozna projekt, uzivatel ho vybere v potvrzovacim dialogu.
- Hodiny musi byt `> 0`; u batch hlasu predstavuji clovekohodiny a mohou byt nad 24, pokud maji vypocet `pocet lidi x hodin na osobu`.
- Sync pro F6 pouziva winner-wins podle `updatedAt`; WorkLog merge zatim nema UUID a pouziva composite key `date|projectName|people`.
- F7+ by melo resit stabilni `clientId` pro projekty/worklogy a reporting worker.

## Compound Engineering Handoff

Pro novou praci:

1. Zacni timto souborem a pak otevri relevantni kanonicky dokument.
2. Pokud jde o produktove chovani, pouzij `ce-brainstorm` nebo `ce-doc-review` nad kanonickymi dokumenty.
3. Pokud jde o implementaci, pouzij `ce-plan` nad aktualnim stavem `main` a cituj repo-relative soubory z oddilu "Aktualni modul Prace".
4. Pokud zmena pujde na GitHub Pages, zahrn do scope i bump verze podle oddilu "Release a verzovani".
5. Historicke `docs/PLAN-*` soubory neber jako zdroj pravdy; ber je jako audit rozhodnuti.
6. Verifikace pro Praci zacina u `battle-plan/docs/F5-verification-report.md` a `battle-plan/docs/F6-verification-report.md`, ale stale chybi standardni `npm test` suite.

## Archiv planu

Tyto soubory popisuji historicke implementacni kroky. Nejsou samy o sobe aktualnim zadanim; aktualni stav je shrnuty vyse.

| Soubor | Vysledek / vztah k aktualnimu stavu |
| --- | --- |
| `PLAN-hybrid-expansion.md` | Dokonceno: subtasky, notes, progress, puvodni tydenni pohled. |
| `PLAN-desktop-evolution.md` | Z velke casti promitnuto do desktop-first UI a sjednoceneho seznamu. |
| `PLAN-urgency-redefinition.md` | Dokonceno: urgentnost `1 | 2 | 3`. |
| `PLAN-deadline-pivot.md` | Dokonceno: tasky se ridi hlavne `deadline`, vcetne Capacity Guardian. |
| `PLAN-export-feature.md` | Dokonceno: export pres email a filtr hotovych v tydnu. |
| `PLAN-ai-manifest.md` | Dokonceno: manifest existuje, chovani je v `AI_MANIFEST.md` a promptu. |
| `PLAN-user-manual.md` | Dokonceno: vystupem je `../navod.md`. |
| `../battle-plan/docs/F5-verification-report.md` | Audit F5 hlasove extrakce pro Praci; stale relevantni jako overeni. |
| `../battle-plan/docs/F6-verification-report.md` | Audit F6 Drive sync pro Praci; stale relevantni jako overeni a zdroj znamych limitaci. |
| `PLAN-model-selection.md` | Historicke. Aktualni model registry v kodu je odlisny a je uvedeny vyse. |
| `PLAN-gemini-live-audio.md` | Archiv zrusene WebSocket/Live cesty. Nahrazeno REST workflow. |
| `PLAN-gemini-live-final.md` | Archiv finalni diagnostiky Live API. Nahrazeno REST workflow. |
| `PLAN-audio-pivot.md` | Rozhodnuti o opusteni Live API zustava platne, ale konkretni modely jsou aktualizovane v kodu. |
| `PLAN-deployment-and-google.md` | Castecne splneno: PWA a Google integrace jsou v kodu. |
| `update-mobile-sync-and-ui.md` | Sync cast hotova; mobilni polish zustava relevantni jako backlog. |
| `STATUS-progres-report.md` | Historicky status k 31. 1. 2026, nahrazen timto indexem. |
| `../auto-sync-evolution.md` | Historicky task; princip timestamp sync je uz soucasti aplikace. |

## Backlog bez duplicity

Aktualni backlog drz v `../FUTURE_PLANS.md`. Pokud se z historickeho planu vraci prace do hry, prepis ji tam jako novou polozku s aktualnim kontextem misto editace stareho `PLAN-*` souboru.
