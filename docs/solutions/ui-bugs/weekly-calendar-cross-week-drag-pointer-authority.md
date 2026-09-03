---
title: Přetažení mezi týdny musí rozhodovat z aktuální polohy ukazatele
date: 2026-09-03
category: ui-bugs
module: BattlePlan weekly calendar
problem_type: ui_bug
component: frontend
symptoms:
  - Úkol nebo schůzku nešlo jedním tahem přesunout mimo právě zobrazený týden.
  - Implementace musela zabránit tomu, aby odchod z hrany těsně před puštěním byl vyhodnocen podle zastaralého stavu.
  - Časovač přechodu mohl doběhnout poté, co ukazatel opustil aktivní hranu.
root_cause: async_timing
resolution_type: code_fix
severity: medium
tags: [weekly-calendar, drag-and-drop, pointer-events, edge-dwell, cross-week, async-timing]
---

# Přetažení mezi týdny musí rozhodovat z aktuální polohy ukazatele

## Problem

Týdenní kalendář dovoloval změnit den a čas jen uvnitř zobrazeného týdne. Přechod na sousední týden navíc vymění podstrom kalendáře klíčovaný hodnotou `weekOffset`, takže aktivní drag musí přežít nový render a následně pracovat s geometrií nových drop zón.

Skrytým rizikem je pořadí událostí. Pohyb ukazatele je kvůli plynulosti slučovaný přes `requestAnimationFrame`, zatímco `pointerup` a konec edge-dwell časovače jsou terminální rozhodnutí. Kdyby používaly stav vypočtený v předchozím snímku, mohly by přesunout položku nebo přepnout týden podle již neplatné polohy.

## Symptoms

- Úkol ani schůzku nebylo možné jedním tahem přesunout do předchozího nebo následujícího týdne.
- Rychlý odchod z edge zóny následovaný puštěním může nastat dříve než další animation frame, takže terminální cesta nesmí spotřebovat zastaralý edge stav.
- Edge timeout mohl doběhnout poté, co ukazatel fyzicky opustil původně aktivovanou hranu.
- Drag preview, otevřený týden a finální reschedule cíl se proto mohly rozcházet.

## What Didn't Work

- Navázat celý lifecycle na původní kartu nestačí. Přepnutí klíčovaného týdne nahradí kalendářní DOM a s ním i původní zdrojový element a drop zóny.
- Ani naposledy publikovaný React stav hrany není spolehlivou autoritou. Aktualizuje se až v naplánovaném animation frame, který může `pointerup` nebo timeout časově předběhnout.
- Samotný vyzbrojený směr časovače nedokazuje, že ukazatel po celou dobu setrval ve stejné zóně. Podmínky pro navigaci je nutné ověřit znovu v okamžiku, kdy má skutečně nastat.

## Solution

Kalendář má během dragu viditelnou levou a pravou edge zónu. Čistý hit test odmítá body mimo viewport a na úzké ploše omezí zóny tak, aby se nepřekrývaly (`battle-plan/src/utils/calendarUtils.ts:136`, `battle-plan/src/utils/calendarUtils.ts:149`). Vstup do zóny spustí 650ms dwell; jeho průběh je vidět jako výplň hrany a dokončení otevře sousední týden (`battle-plan/src/components/WeeklyCalendar.tsx:56`, `battle-plan/src/components/WeeklyCalendar.tsx:251`).

Drag session žije v refs a globálních pointer listenerech nad klíčovaným týdnem, takže přežije jeho výměnu (`battle-plan/src/components/WeeklyCalendar.tsx:369`). Po změně týdne `useLayoutEffect` znovu změří viewport a denní pruhy a vyhodnotí poslední polohu ukazatele proti novému layoutu (`battle-plan/src/components/WeeklyCalendar.tsx:384`). Samotný týden vstupuje směrovým spring přechodem (`battle-plan/src/components/WeeklyCalendar.tsx:560`).

Dvě terminální cesty rozhodují synchronně:

- Dwell callback znovu načte poslední souřadnice a přepne týden jen tehdy, pokud stále odpovídají vyzbrojené hraně (`battle-plan/src/components/WeeklyCalendar.tsx:251`, `battle-plan/src/utils/calendarUtils.ts:159`).
- `pointerup` určí hranu přímo z `event.clientX` a `event.clientY`. Pokud je ukazatel mimo hranu, zruší edge intent, obnoví geometrii a ze stejných souřadnic vypočte finální drop target (`battle-plan/src/components/WeeklyCalendar.tsx:326`).

Finální uložení zůstává sémantické: celodenní cíl odstraní čas, schůzka ukládá začátek bloku a úkol deadline na jeho konec podle délky. Bezezměnový drop se nepersistuje (`battle-plan/src/utils/calendarUtils.ts:175`, `battle-plan/src/utils/calendarUtils.ts:197`).

Regresní unit testy pokrývají hranice zón, jejich nepřekrývání v úzkém viewportu a rozhodovací predikáty použité pro scénáře odchodu před dalším frame a timeoutu po opuštění hrany (`battle-plan/src/utils/calendarUtils.test.ts:64`, `battle-plan/src/utils/calendarUtils.test.ts:81`, `battle-plan/src/utils/calendarUtils.test.ts:88`).

## Why This Works

Řešení odděluje tři časové domény. Pointer event poskytuje pravdu o poloze v okamžiku události, animation frame pouze dávkuje průběžné vykreslení a hit testing a timeout reprezentuje úmysl uživatele setrvat na hraně. Terminální cesty proto stav z animation frame nekonzumují bez ověření.

Zároveň odděluje životnost dragu od životnosti geometrie. Drag session zůstává zachovaná nad rerenderem týdne, ale cache DOM rozměrů se při přechodu zahodí a změří znovu. Uživatel tak může pokračovat stejným tahem v novém týdnu, aniž by se drop vyhodnocoval proti starému DOM.

## Prevention

- `pointerup`, timeout, cancel a jiné terminální vstupy rozhodujte z event-time dat nebo znovu ověřených aktuálních souřadnic, ne pouze z posledního renderovaného stavu.
- Dwell, hover a long-press callbacky musí při doběhnutí znovu ověřit všechny podmínky opravňující akci.
- Pokud interakce vyvolává keyed remount, držte její lifecycle nad remountovaným podstromem; lokální DOM geometrii naopak považujte za pomíjivou.
- Čistěte časovače, animation frames a transientní intent při `pointercancel`, blur, skrytí dokumentu a unmountu.
- Boundary testy doplňte testy pořadí událostí, zejména „odchod před frame“ a „timeout po odchodu“.
- Perzistujte jediný sémantický výsledek až po vyřešení finálního cíle; zrušený nebo bezezměnový drop nic nezapisuje.

## Related Issues

- `docs/solutions/design-patterns/responsive-surface-motion-system.md`
- `docs/solutions/design-patterns/weekly-task-history-and-rescheduling.md`
- `docs/solutions/ui-bugs/worklog-voice-proposal-cancel-reopen.md`
