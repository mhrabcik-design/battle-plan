# AI manifest

Tento dokument popisuje stabilní kontrakt AI zpracování. Konečným zdrojem pravdy jsou prompty a normalizace v `battle-plan/src/services/semanticEngine.ts`, `workLogExtractor.ts` a `taskNormalization.ts`; při rozporu se dokument opraví podle kódu a regresních testů.

## Společná pravidla

- Výstup je validní JSON bez markdownového obalu.
- Výchozí jazyk je čeština.
- Časy jsou `HH:MM` ve 24hodinovém formátu.
- Datum je absolutní `YYYY-MM-DD`.
- Hlavní hlasový tok používá pouze typy `task`, `meeting` a `thought`.
- Urgentnost je `1 | 2 | 3`, výchozí `2`.
- Původní hlasový obsah hlavního toku se zachovává v `internalNotes`.
- Při aktualizaci se nová metadata přepisují, ale existující popis a podúkoly se bez výslovného důvodu nezahazují.

## Profily

| Profil | Typ | Chování |
| --- | --- | --- |
| Manažer | `task` | Stručný titul, deadline, profesionální popis a logické podúkoly |
| Zapisovatel | `meeting` | Účastníci, čas, místo, klíčové body a akční kroky |
| Partner | `thought` | Aktivní rozvinutí nápadu, souvislosti, rizika a další kroky |
| Práce | `WorkLog` | Faktická batch extrakce projektu, lidí, data a člověkohodin |

## Termíny

- Task používá primárně `deadline`; pokud není samostatně řečeno datum začátku, `date` se zrcadlí.
- Meeting používá `date`; `deadline` se zrcadlí na stejné datum.
- „Dnes“, „zítra“ a „pozítří“ se počítají proti datu předanému promptu.
- „V úterý“ znamená nejbližší budoucí úterý; pokud je právě úterý, znamená příští týden.
- „Příští úterý“ nebo „příští týden v úterý“ přidává další týden.
- Hlavní prompt nepodporuje neurčité dlouhé horizonty typu „za měsíc“ bez dalšího kontextu.

## Celodennost a délka

- Výrazy „na celý den“, „celodenní“ nebo „bez času“ nastavují `isAllDay: true`.
- Celodenní záznam nemá `startTime` a používá typovou výchozí délku.
- Výchozí délka je 30 minut pro task a 60 minut pro meeting.
- Výchozí čas bez explicitního zadání je 15:00 pro task a 09:00 pro meeting.

## WorkLog kontrakt

WorkLog hlas používá samostatný prompt a potvrzovací UI.

- Výstup je batch `entries[]` s `projectName`, `people`, `hoursPerPerson`, `totalHours`, `description`, `date` a vysvětlením výpočtu.
- `totalHours` jsou člověkohodiny a mohou být nad 24, pokud je výpočet vysvětlen.
- „Minulý týden“ znamená pondělí až pátek, pokud uživatel výslovně nezmíní víkend.
- Korekce konkrétního dne nesmí změnit ostatní dny v batchi.
- Neznámí lidé dostanou stabilní označení `Pracovník 1`, `Pracovník 2`, … v rámci diktátu.
- Chybějící projekt, lidé, hodiny nebo platné datum vyžadují potvrzení.
- Schůzka se nemá automaticky započítat jako odpracovaná práce.

## Agent Bridge write kontrakt

Agent zapisuje příkazy do Google Drive souboru `agent-pending-writes.json`. Konečným zdrojem pravdy pro datový tvar je `battle-plan/src/services/agentBridge.ts`.

- Kořen souboru obsahuje `writes[]`.
- Každý zápis má stabilní `id`, `action`, `created_at` a právě jeden odpovídající payload: `task_data`, `worklog_data`, `project_data` nebo `settings_data`.
- Podporováno je 13 akcí: `create_task`, `update_task`, `delete_task`, `complete_task`; `create_worklog`, `update_worklog`, `delete_worklog`; `create_project`, `update_project`, `delete_project`; `create_settings`, `update_settings`, `delete_settings`.
- `create_project` založí aktivní projekt. Stejný normalizovaný název aktivního projektu je terminální duplicita; stejný název archivovaného projektu obnoví původní ID. Volitelná `color` při obnovení nahradí uloženou barvu.
- `delete_project` je měkká archivace (`isActive: false`): projekt ani jeho historické WorkLogy se nemažou. Samostatná restore akce neexistuje; pro obnovu použij `create_project` se stejným názvem.
- `update_worklog` bez `projectId` a `projectName` zachová historické přiřazení. Změna projektu musí poslat obě pole a cílit na aktuálně aktivní shodné ID/jméno; `syncId` ani auditní pole se aktualizací nemění.
- Aplikace načítá jen dosud neaplikované zápisy, zrcadlí jejich stav do `agentInbox` a provede doménovou změnu. Úspěšné i deterministicky neplatné zápisy dostanou `applied_at` zpět do Drive souboru; přechodná I/O selhání zůstávají k opakování.
- Změna seznamu akcí nebo payloadu vyžaduje současnou úpravu typů, mapy `ENTITY_BY_ACTION`, testů Agent Bridge a tohoto dokumentu.

## Datové mapování

| Typ | Časové pole | Text | Audit vstupu |
| --- | --- | --- | --- |
| Task | `deadline`, volitelně `date` | `description`, `subTasks` | `internalNotes` |
| Meeting | `date`, `startTime`, `duration` | strukturovaný zápis | `internalNotes` |
| Thought | `date` | rozvinutý nápad | `internalNotes` |
| WorkLog | `date`, `hours` | popis odvedené práce | batch assumptions / calculation note |

Změna tohoto kontraktu vyžaduje odpovídající změnu promptu, normalizace a testů.
