---
title: "Suggestions Color Character - Plan"
type: fix
date: 2026-09-19
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Suggestions Color Character - Plan

## Goal Capsule

- **Objective:** Návrhy mají znovu známou barevnou výraznost, která usnadňuje orientaci při čtení seznamu.
- **Means:** Vrátit významové akcenty do současného rozložení podle KTD1.
- **Authority:** Uživatelský požadavek určuje výsledek; R1–R2 určují rozsah, KTD1–KTD2 technické provedení.
- **Execution:** Jedna lokální úprava stylů a kontrola v prohlížeči; dokončení, commit a případné publikování vlastní volající workflow.
- **Stop conditions:** Zastavit rozšíření rozsahu, pokud by bylo nutné měnit chování návrhů nebo datové služby.

## Product Contract

### Summary

Vrátit kartám a filtrům Návrhů barevné rozlišení při zachování současného zjednodušeného rozložení.

### Problem Frame

Při posledním zjednodušení se ztratila výraznost, na kterou si uživatel zvykl. Nové rozložení se mu líbí, ale převážně neutrální prvky oslabily známý barevný charakter stránky.

### Requirements

- R1. Sekce Návrhy znovu výrazněji barevně rozlišuje kategorie, prioritu, stavy a hlavní akce.
- R2. Současné zjednodušené uspořádání a zrychlení zůstávají zachované.

### Scope Boundaries

Změna se týká vzhledu Návrhů. Nepřidává funkce, animace ani závislosti; nemění handlers, oprávnění, ukládání, synchronizaci ani ostatní stránky.

## Planning Contract

### Key Technical Decisions

- KTD1. **Lokální paleta pro oba motivy.** Použít existující přístup s komponentními CSS třídami a variantou přes `html[data-theme='light']`; motiv aplikace nemusí odpovídat systémovému motivu. Akcenty omezit na Návrhy, aby se nezměnily sdílené neutrální tokeny. Podklad: `docs/solutions/design-patterns/theme-prepaint-and-legacy-surface-bridge.md`.
- KTD2. **Pouze prezentace.** Pro R2 ponechat současné rozměry a pořadí prvků, dávky po 20 kartách, sbalování popisů a konverzací i zachování rozpracovaných odpovědí při obnově. Barva doplňuje existující texty a ikony; nepřidávat React state ani nové datové větvení.

### Assumptions

Předpoklady pro provedení bez dalšího výběru uživatele:

- Původní rodiny barev jsou vhodný výchozí bod: kategorie indigo, violet, emerald, cyan a pink; priority red, amber a slate; vyřízení emerald, zamítnutí red a odklad amber.
- Barevné štítky, zvýrazněná hlavní akce a střídmé barevné filtry obnoví charakter bez celoplošného přebarvení karet.
- Čitelnost se posoudí v obou motivech na telefonu i desktopu. Běžný text na nových barevných plochách má dosáhnout kontrastu alespoň 4,5:1, měřeného ze skutečných složených barev.

## Implementation Units

### U1. Restore suggestion accents

**Goal:** Naplnit R1 při zachování R2.

**Dependencies:** Žádné další jednotky; výchozí stav aplikace je verze 4.3.72.

**Files:** `battle-plan/src/components/SuggestionCard.tsx`, `battle-plan/src/pages/SuggestionsPage.tsx`, `battle-plan/src/index.css`.

**Approach:** Připojit lokální barevné role k existujícím štítkům, ovládacím prvkům a filtrům podle KTD1–KTD2. Použít paletu uvedenou v Assumptions a odstíny doladit podle vykreslených motivů.

**Patterns to follow:** Existující doménové třídy `.task-warning` a `.planning-stat` v `battle-plan/src/index.css`; zachování výkonu popsané v `docs/plans/2026-09-19-0842-perf-suggestions-visual-speed-plan.md`.

**Execution note:** Nejprve zachytit současný vzhled na stejných datech; po úpravě porovnat screenshoty.

**Test expectation:** none — čistá změna stylů bez změny chování; nové unit testy by kopírovaly implementaci.

**Verification:**

1. Na sadě obsahující všechny kategorie, priority a stavy jsou významové barvy zřetelné v light i dark při šířkách 390 a 1440 px; text zůstává čitelný a stránka vodorovně nepřetéká.
2. Vybraný filtr se liší od ostatních i jinak než odstínem; klávesový focus, disabled a hover prvků zůstávají patrné.
3. Při 200 návrzích se nejprve vykreslí 20 karet; načtení další dávky a přepnutí filtru fungují stejně jako před úpravou.
4. Diff nezasahuje do existujících handlers ani logiky dávkování, obnovy a rozepsané odpovědi.

## Verification Contract

V `battle-plan/` projdou `npm run lint`, `npm run build` a `npm run check:theme`. Pro U1 přiložit srovnání screenshotů a záznam kontroly kontrastu podle Assumptions. Prohlížečová kontrola proběhne na testovacích datech bez zásahů do živého Google Drive; stávající behaviorální testy se rozšíří pouze při skutečné změně chování.

## Definition of Done

U1 splňuje ověření, změny nezasahují za vyjmenované soubory a vzhled odpovídá R1–R2. Diff neobsahuje experimentální kód ani pomocné testovací vstupy a výsledek má lokální commit s ověřovacími podklady.
