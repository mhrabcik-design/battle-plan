# Produktový kontrakt

## Účel

Bitevní Plán je osobní desktop-first PWA pro rychlé hlasové zachycení plánu a skutečně odvedené práce. Uživatel může data ručně upravit, synchronizovat s Google službami a ověřit stav integrací v diagnostice.

## Produktové oblasti

| Oblast | Úloha |
| --- | --- |
| Plán | Dnešní strategický přehled |
| Týden | Časová osa 7:00–19:00 |
| Úkoly | Deadline, urgentnost, podúkoly a postup |
| Schůzky | Datum, čas, délka a volitelný Google Calendar event |
| Myšlenky | Rozvinutí a strukturování nápadů |
| Práce | Evidence projektu, lidí, data a člověkohodin |
| Návrhy | Kontrolované převzetí návrhů z integrace Anu |
| Diagnostika | Build identity a oddělený stav autentizace a sync subsystémů |

## Základní pravidla

- Čas se zadává a zobrazuje ve 24hodinovém evropském formátu.
- Úkol řídí primárně `deadline`; schůzka a WorkLog používají `date` jako datum konání.
- Urgentnost má tři stupně `1 | 2 | 3`, výchozí je `2`.
- WorkLog je evidence reality, ne další seznam úkolů ani automatický přepis schůzek.
- Batch WorkLog hodiny jsou člověkohodiny: počet lidí × hodiny na osobu.
- Hlasový návrh WorkLogu se před uložením potvrzuje; nejisté datum, projekt nebo lidé nesmí projít tiše.
- Novější synchronizační změna vyhrává podle `updatedAt`; smazané tasky zůstávají jako soft-delete tombstones.
- Citlivé tokeny, Gemini klíč a uživatelská data zůstávají v lokálním úložišti / uživatelově Google účtu, ne v repozitáři.

## Integrace

- Gemini REST API zpracovává hlavní hlasový vstup a samostatný WorkLog batch prompt.
- Google Drive drží task backup, WorkLogs a integrační soubory ve sdílené složce BattlePlan.
- Google Tasks se slučují s lokálními úkoly v relevantních pohledech.
- Google Calendar je volitelný výstup schůzek.
- Agent bridge zpracovává explicitní příkazy přes inbox a zaznamenává jejich stav do Dexie.

## Hranice současného produktu

- Aplikace je frontend-only a nemá vlastní serverovou databázi.
- WorkLogs používají stabilní `syncId`, ale projekty stále spoléhají na lokální číselné ID a denormalizovaný název.
- Reporting práce je zatím přehled v UI, ne hotový fakturační nebo mzdový výstup.
- Konflikty v Google Calendar se před uložením automaticky nevyhodnocují.
- Sémantické vyhledávání nad lokálními záznamy není implementované.

Další otevřené směry jsou výhradně v [ROADMAP.md](ROADMAP.md).
