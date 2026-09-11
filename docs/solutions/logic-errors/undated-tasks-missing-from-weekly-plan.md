---
title: Úkoly bez termínu mizely z týdenního plánu
date: 2026-09-11
category: logic-errors
module: Task scheduling
problem_type: logic_error
component: service_layer
symptoms:
  - "Úkol vytvořený bez data je v seznamu úkolů, ale chybí v týdenním plánu."
root_cause: missing_validation
resolution_type: code_fix
severity: medium
tags: [tasks, deadline, weekly-calendar, voice, suggestions]
---

# Úkoly bez termínu mizely z týdenního plánu

## Problém

Uživatel pracuje hlavně v týdenním plánu. Úkol bez data přijatý z diktování nebo od agenta se mohl uložit, ale plán jej neukázal. Oprava je připravena ve feature větvi; tento záznam nepotvrzuje nasazení.

## Příznaky

Seznam úkolů vybírá podle typu. Týdenní dotaz v `battle-plan/src/App.tsx` vybírá rozsah `date` nebo `deadline`, zatímco `battle-plan/src/components/WeeklyCalendar.tsx` řadí úkoly do dní podle `deadline`. Pouhé doplnění `date` proto nestačí.

## Řešení

`ensureTaskDeadline` v `battle-plan/src/services/taskNormalization.ts` zachová platný termín, případně převezme platné `date`. Chybí-li obě data, uloží pátek aktuálního lokálního týdne pondělí–neděle. V sobotu a neděli jde o předchozí pátek: cílem je viditelnost v aktuálním týdnu, nikoli automatické odsunutí do dalšího týdne. Platná odlišná data začátku a dokončení zůstávají zachována. Myšlenky a schůzky toto pravidlo nepoužívají.

Pravidlo běží ve společné normalizaci diktování a agentních zápisů, při převodu návrhu na úkol a při ručním uložení editoru. Editor vysvětluje doplnění termínu přímo u pole data. Cílené integrační testy před opravou reprodukovaly chybějící termín ve všech třech cestách vytváření; po opravě prošly. Prohlížeč ověřil vymazání termínu v editoru, uložení a viditelnost po reloadu na desktopu a mobilu.

## Proč při zápisu

Datum se musí uložit jednou. Výpočet náhradního pátku jen při renderování by při přechodu týdne úkol samovolně přesunul a nesjednotil seznam, editor a synchronizovaná data. Obecný databázový hook by zase mohl přepsat historická data při obnově zálohy nebo při příjmu dat z jiného zařízení. Proto jsou pokryté autorské zápisy a synchronizační import zůstává beze změny.

Starší nedatované záznamy se hromadně nepřepisují; pravidlo se na ně uplatní při ručním či sémantickém uložení. Datum není pohyblivý týdenní backlog: s novým týdnem se samo neposouvá.

## Prevence

Při přidávání nové cesty vytvoření nebo uložení úkolu použít stejnou normalizaci před zápisem. Testovat skutečně uložené `deadline`, ne jen datum zobrazené formulářem. Regresní kontroly jsou v `battle-plan/src/services/taskNormalization.test.ts`, `battle-plan/src/services/agentBridge.test.ts` a `battle-plan/src/services/suggestionRegistry.test.ts`.

## Související

- [Týdenní přesouvání a historie úkolů](../design-patterns/weekly-task-history-and-rescheduling.md)
