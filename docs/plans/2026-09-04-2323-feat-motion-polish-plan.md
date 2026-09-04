---
title: Motion Polish - Plan
type: feat
date: 2026-09-04
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Motion Polish - Plan

## Goal Capsule

- Objective: Interakce Battle Planu působí klidně, plynule a poskytují jasnou odezvu bez rušivého pohybu.
- Means: Doplnění existujícího motion systému (KTD1).
- Authority: Aktuální zadání uživatele, projektové instrukce, tento plán.
- Execution profile: Malá lokalizovaná úprava prezentace, bez změn datových operací.
- Stop conditions: Konflikt s existujícími změnami nebo nemožnost ověřit interakce.
- Tail ownership: Implementace vrací řízení LFG; výstupem je otevřený PR, nikoli automatické sloučení do main.

## Product Contract

### Summary

Projít aktuální design a vylepšit animace běžných ovládacích prvků a dialogů.

### Problem Frame

Současné rozhraní má společné časové tokeny, ale dialogy používají samostatně nastavenou pružinu. Omezení pohybu zkracuje CSS přechody, aniž by odstranilo posun a změnu měřítka při hoveru a stisku.

### Requirements

- R1. Zkontrolovat rozložení a odezvu současného rozhraní na skutečně vykreslené aplikaci.
- R2. Zlepšit konzistenci vstupu a výstupu sdílených dialogů a panelů.
- R3. Zachovat vizuální odezvu tlačítek i při omezeném pohybu bez posouvání nebo změny jejich velikosti.

## Planning Contract

### Assumptions

- Rozsah tohoto průchodu je cílené dotažení existujícího designu, nikoli přestavba navigace nebo palety.
- Zachováme light/dark/system témata a doménové chování.
- Krátký opacity přechod je vhodný i v režimu omezeného pohybu.
- Změny vzniknou na samostatné větvi a nebudou automaticky nasazeny.

### Key Technical Decisions

- KTD1. Rozšířit existující OverlaySurface a CSS ovládacích prvků, bez nové animační knihovny; sdílená komponenta již vlastní focus a klávesnici.
- KTD2. Pohyb panelu určovat explicitně podle preference reduced motion; jeho opacity a transform neanimovat současně s opacity nadřazeného celého overlaye.
- KTD3. CSS reduced-motion pravidla omezit na pohyb interaktivních tříd, nikoli globálně nulovat transform a poškodit centrování nebo drag geometry.

## Implementation Units

### U1. Consistent overlay motion

- Goal: Krátký vstup/výstup bez násobené opacity a bez prostorového pohybu při reduced motion.
- Requirements: R2.
- Dependencies: Žádné.
- Files: `battle-plan/src/components/ui/OverlaySurface.tsx`, `battle-plan/src/utils/overlayMotion.ts`, `battle-plan/src/utils/overlayMotion.test.ts`, `battle-plan/src/components/SlashCommandPalette.tsx`, `battle-plan/src/components/WorkLogCalendar.tsx`, `battle-plan/src/components/WorkLogVoiceBar.tsx`.
- Approach: Vytvořit čistý rozhodovací helper dle KTD2 a použít jej ve sdíleném overlayi. Prověřit AnimatePresence u všech volajících a doplnit chybějící boundary, aby exit opravdu doběhl. Zachovat portal, inert, Escape a focus lifecycle až do skutečného unmountu.
- Patterns: `battle-plan/src/components/ui/OverlaySurface.tsx`.
- Test scenarios:
  1. Dialog má klidný krátký vstup a kratší výstup.
  2. Sheet zachovává směrový vstup.
  3. Reduced motion varianta nemá prostorový posun ani změnu měřítka.
  4. Otevření, Escape a opakované otevření nastavení zachovává focus a interakci s pozadím.
- Verification: Unit testy helperu a vizuální kontrola dialogu v prohlížeči.

### U2. Reduced-motion controls and visual verification

- Goal: Tlačítka zůstanou na místě, pokud uživatel omezí pohyb.
- Requirements: R1, R3.
- Dependencies: U1.
- Files: `battle-plan/src/index.css`, `battle-plan/src/utils/motionStyles.test.ts`, `docs/audits/motion-polish-2026-09-04/README.md`.
- Approach: Dle KTD3 zachovat color/border odezvu, odstranit hover/active posun u sdílených tlačítek a zachovat transform nutný pro layout. Zaznamenat konkrétní kontrolované obrazovky a limity auditu.
- Patterns: `docs/solutions/design-patterns/responsive-surface-motion-system.md`.
- Test scenarios:
  1. Reduced motion ruší scale/translate tlačítek, ne transform všech elementů.
  2. Běžný režim má hover a press feedback a disabled ovládání nepůsobí aktivně.
  3. Dialog ani tlačítka nemění existující barevné role.
- Verification: CSS kontrakt, lint, testy a produkční build; screenshoty a klávesnicová kontrola.

## Verification Contract

V adresáři `battle-plan`: `npm test`, `npm run lint`, `npm run build`, `npm run check:theme`.
Prohlížeč: nastavení otevřít/zavřít/opakovaně otevřít, ověřit focus, screenshot a žádný nechtěný posun layoutu.
Ověřit také sheet a při dostupné emulaci reduced motion dialog, sheet a hover/stisk sdíleného tlačítka. Bez emulace výslovně uvést mezeru vizuálního ověření; helper/CSS test není náhradou skutečného pozorování.
Záznam musí odlišovat skutečná pozorování od vlastností ověřených pouze testem nebo kódem.

## Definition of Done

Obě jednotky splní scénáře, ověřovací příkazy projdou, audit popisuje ověřené stavy i mezery. Diff neobsahuje experimentální kód, cizí lockfiles ani změny main. Review a browser kontrola proběhnou před otevřením PR.
