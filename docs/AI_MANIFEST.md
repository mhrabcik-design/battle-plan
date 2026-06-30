# AI INTELLIGENCE MANIFEST (v4.2)

Tento dokument definuje, jak umělá inteligence v aplikaci **Bitevní Plán** zpracovává vstupy, jak strukturalizuje data a jakou úroveň iniciativy projevuje u různých typů záznamů.

Hlavní plánovací prompt je v `battle-plan/src/services/semanticEngine.ts`. Záložka Práce má samostatný specializovaný extractor v `battle-plan/src/services/workLogExtractor.ts`.

---

## 🏗️ 1. Obecné principy zpracování
- **RAW Data:** Původní, neupravený přepis hlasu musí být VŽDY uložen do pole `internalNotes`.
- **Jazyk:** Výstup je vždy v češtině, pokud není v audiu explicitně vyžádáno jinak.
- **Formát:** Výstupem je vždy validní JSON objekt připravený pro databázi Dexie.

---

## 📋 2. Profily a Iniciativa

### 👔 A. Profil: MANAŽER (Úkoly / Task)
*Zaměření na exekuci, termíny a efektivitu.*

- **Iniciativa:** Střední až Vysoká.
- **Pravidla zápisu:**
    - AI domýšlí logické podúkoly (sub-tasks), i když nejsou explicitně řečeny.
    - Pokud chybí termín, nastaví konec dnešního dne (deadline).
    - Pokud je zmíněn čas (např. "zabere to hodinu"), nastaví `duration: 60`.
- **Struktura názvu:** `[ÚKOL] + STRUČNÝ POPIS` (např. "[ÚKOL] PŘÍPRAVA PREZENTACE").
- **Bulletpointy:** Pouze pro `subTasks`. Description zůstává stručný.

### 📝 B. Profil: ZAPISOVATEL (Schůzky / Meeting)
*Zaměření na kontext, účastníky a následné kroky.*

- **Iniciativa:** Střední.
- **Pravidla zápisu:**
    - Identifikuje pole: **KDO** (účastníci), **KDY** (čas), **KDE** (lokace).
    - Vytváří přehlednou strukturu v `description`.
    - Identifikuje úkoly, které ze schůzky vyplynuly, a dává je do `subTasks`.
- **Struktura názvu:** `JMÉNO/FIRMA: TÉMA` (např. "HONZA: MARKETING STRATEGIE").
- **Bulletpointy:** Povinné pro "Klíčové body" a "Akční kroky" v poli `description`.

### 💡 C. Profil: PARTNER (Myšlenky / Thought)
*Zaměření na rozvoj nápadů, kreativitu a brainstorming.*

- **Iniciativa:** **MAXIMÁLNÍ**.
- **Pravidla zápisu:**
    - AI neprovádí jen prostý zápis, ale aktivně myšlenku **rozvíjí**.
    - Hledá souvislosti, navrhuje logické kroky, upozorňuje na potenciální rizika nebo příležitosti.
    - Transformuje mlhavé nápady do strukturovaných konceptů.
- **Struktura názvu:** `💡 + NÁPAD/MYŠLENKA` (např. "💡 PŘEDPLATNÉ NA KÁVU").
- **Bulletpointy:** Bohaté využití v `description` pro rozčlenění nápadu (např. Marketing, Logistika, Business model).

### 🧰 D. Specializovaný profil: PRÁCE (WorkLog)
*Zaměření na faktickou evidenci odpracované práce.*

- **Použití:** Pouze v záložce `Práce`; nejde přes běžný task/meeting/thought prompt.
- **Iniciativa:** Nízká až střední. AI má extrahovat fakta, ne plánovat nebo domýšlet rozsáhlé kroky.
- **Výstupní pole:** batch návrh `entries[]`, kde každý záznam obsahuje `projectName`, `people`, `hoursPerPerson`, `totalHours`, `description`, `date` a vysvětlení výpočtu.
- **Projekt:** Pokud projekt nejde spolehlivě najít, uživatel ho doplní v potvrzovacím dialogu.
- **Hodiny:** U batch diktátu se počítají jako člověkohodiny (`počet lidí × hodiny na osobu`); total může být nad 24, pokud je vysvětlen výpočtem.
- **Datum:** Datum reálného výkonu práce. Pokud není řečeno, použije se dnešek.
- **Schůzky:** Diktát vypadající jako schůzka/jednání nemá navyšovat sumu odpracovaných hodin.
- **Relativní období:** `minulý týden` znamená pracovní dny pondělí až pátek; korekce typu `ve středu ještě jeden člověk` mění jen dotčený den.
- **Neznámí pracovníci:** Pokud uživatel řekne počet bez jmen, AI použije `Pracovník 1`, `Pracovník 2` atd.

---

## 📊 3. Technické Mapování Dat

| Typ | Pole času | Hlavní text | RAW / poznámky |
|:--- |:--- |:--- |:--- |
| **Úkol** | `deadline` prioritní | Exekutivní summary | `internalNotes` = RAW přepis + kontext |
| **Schůzka** | `date` a `startTime` konání | Strukturovaný zápis (KDO, KDE...) | `internalNotes` = RAW přepis |
| **Myšlenka** | `date` vzniku | Rozvinutý brainstormingový výstup | `internalNotes` = RAW přepis |
| **Práce / WorkLog** | `date` výkonu práce | `description` = co se dělalo | Specializovaný batch extractor, bez `internalNotes` |

---

## 🔄 4. Protokol změn (Versioning)
Pokud uživatel pocítí, že AI je "příliš kreativní" nebo naopak "málo iniciativní", upraví se tento manifest a následně promítne do systémového promptu v `semanticEngine.ts`.

**Aktuální prompt v kódu:** `battle-plan/src/services/semanticEngine.ts` (`getSystemPrompt`).
**Výchozí model v kódu:** `gemini-3-flash-preview`.
**WorkLog prompt v kódu:** `battle-plan/src/services/workLogExtractor.ts` (`WORKLOG_SYSTEM_PROMPT`).

---

## 📅 5. Pokročilá práce s termíny (Relativní data)
AI musí být schopna přepočítat relativní výrazy na absolutní data ve formátu `YYYY-MM-DD`.

- **Referenční bod:** AI je vždy předáno aktuální datum a název dne v týdnu.
- **Relativní výrazy:**
  - **Dnes**: Aktuální datum.
  - **V [den]** (např. "v pátek" - pokud je dnes čtvrtek) -> Zítra (+1 den).
  - **V [den]** (pokud je dnes ten samý den) -> Příští výskyt (+7 dní).
  - **Příští [den]** nebo **Příští týden v [den]** -> Nejbližší výskyt + 7 dní.
- **Omezení:** Relativní termíny se podporují primárně pro aktuální a příští týden. Pro delší horizonty (za měsíc atd.) se řiď kontextem nebo ponech dnešek.

## 6. Oddělení plánování a evidence práce

- `tasks`, `meetings` a `thoughts` popisují plán, závazky a znalostní kontext.
- `workLogs` popisují realitu: co se skutečně dělalo, na jakém projektu, kdo u toho byl a kolik hodin to trvalo.
- AI nesmí automaticky převádět schůzky na pracovní hodiny bez explicitního záměru uživatele.
- Další Compound Engineering plánování by mělo držet tuto hranici: Práce je reporting/evidence, ne další úkolový seznam.
