---
title: Resize kalendáře musí oddělit sémantický čas od oříznuté geometrie
date: 2026-09-04
category: ui-bugs
module: BattlePlan weekly calendar
problem_type: ui_bug
component: frontend
symptoms:
  - Položka začínající před 07:00 rostla při resize více, než odpovídalo pohybu ukazatele.
  - Úchyt položky přesahující 20:00 se vykreslil pod viditelným koncem kalendáře.
  - Položka začínající po 19:30 mohla uložit konec za hranicí 20:00.
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [weekly-calendar, resize, pointer-events, time-semantics, clipping]
---

# Resize kalendáře musí oddělit sémantický čas od oříznuté geometrie

## Problem

Týdenní kalendář zobrazuje jen interval 07:00-20:00, ale uložený úkol nebo schůzka může začínat dříve nebo končit později. Resize nesmí zaměnit sémantický interval položky za jeho oříznutou podobu ve viewportu.

## Symptoms

- U položky začínající před 07:00 se nová délka počítala od skrytého sémantického začátku, přestože uživatel táhl viditelnou spodní hranu.
- Layout ořízl interval na 20:00, ale karta odvodila výšku z původní délky a umístila úchyt mimo kalendář.
- Minimální délka 30 minut mohla u startu po 19:30 znovu posunout sémantický konec za již aplikovanou hranici 20:00.

## What Didn't Work

- Počítat novou délku přímo jako `pointerEnd - semanticStart`. Souřadnice ukazatele patří do viditelného kalendáře, zatímco sémantický začátek může ležet mimo něj.
- Oříznout nejprve konec na 20:00 a potom vynutit minimum. Druhá operace může první hranici zrušit.
- Použít oříznutý interval jen pro pozici karty a její výšku nechat vycházet z raw `duration`.

## Solution

Doménový helper nejprve vytvoří raw blok se sémantickým začátkem, koncem a normalizovanou délkou. Vizuální layout z tohoto bloku ořízne obě hrany na 07:00-20:00.

Resize používá rozdíl mezi snapnutou polohou ukazatele a původní viditelnou spodní hranou:

```ts
const delta = snappedPointerEnd - clippedOriginalEnd;
const duration = clamp(originalDuration + delta, minimum, dayEnd - semanticStart);
```

Tím se zachová fixní sémantická hrana meetingu i úkolu a viditelný růst odpovídá pohybu ukazatele. Když mezi sémantickým začátkem a 20:00 nezbývá ani minimální délka, helper vrátí ne-resizable výsledek a komponenta úchyt nevykreslí.

Komponenta odvozuje `top` i `height` ze stejného oříznutého intervalu. Pro preview vytvoří dočasný task s resize patchem a znovu použije stejný interval helper; collision sloupce přitom mohou zůstat během gesta stabilní.

## Why This Works

Poloha ukazatele a CSS geometrie sdílejí viditelný souřadnicový systém, zatímco perzistence zachovává doménovou časovou sémantiku. Delta mezi dvěma viditelnými konci lze bezpečně přičíst k původní sémantické délce, aniž by se ztratil skrytý kus intervalu.

Jedna horní mez `dayEnd - semanticStart` současně zajišťuje, že výsledný sémantický konec nepřekročí 20:00. Kontrola dostupného prostoru před zobrazením úchytu řeší případ, kdy se minimum a denní hranice navzájem vylučují.

## Prevention

- Pro pointer matematiku používejte rozdíl souřadnic ze stejného vizuálního prostoru; raw a clipped hodnoty nekombinujte v jednom odečtu.
- Pořadí clampů navrhujte tak, aby minimální hodnota nemohla porušit již vynucené maximum.
- Pozici, výšku a úchyt karty odvozujte z jednoho kanonického vizuálního intervalu.
- Boundary testy zahrňte na obou stranách viewportu, včetně stavu, ve kterém není možné současně splnit minimum a maximum.

## Related Issues

- `docs/solutions/ui-bugs/weekly-calendar-cross-week-drag-pointer-authority.md`
- `docs/solutions/design-patterns/weekly-task-history-and-rescheduling.md`
- `docs/solutions/design-patterns/responsive-surface-motion-system.md`
