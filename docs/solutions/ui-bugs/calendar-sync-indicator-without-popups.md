---
title: Stav Google Kalendáře bez upozornění po každé změně
date: 2026-10-10
category: ui-bugs
tags: [calendar, synchronization, outbox, react, accessibility]
---

# Stav Google Kalendáře bez upozornění po každé změně

Po lokálním uložení, přesunu, smazání nebo ručním odeslání záznamu se
zobrazovalo upozornění, pokud Google ještě nepotvrdil přenos. Čekání na
připojení nebo další pokus je běžný stav uložené fronty, proto oznámení po
každé změně rušilo práci.

`useTaskCommands` nyní vrací úspěch po platném lokálním uložení bez hlášky
o čekajícím přenosu. Skutečné chyby uložení a omezení položek pouze pro čtení
zůstávají zachované. Samotná fronta, doručování a pravidla vlastnictví účtu
se nemění.

Sdílená kontrolka `CalendarSyncIndicator` je v postranním panelu a mobilní
hlavičce. Kliknutí otevře nastavení s totožným stavem a podrobnostmi.
`useExternalEffectOutbox` předává souhrn pouze kalendářových efektů ze
stejného pozorování databáze, které již obsluhuje doručování. Kontrolka
nepřidává další periodické načítání ani kopii stavu ve vlastním React efektu.

Zelená vyžaduje prázdnou frontu bez platných selhání a konfliktů, přihlášený
aktuální účet, připojení a zkontrolovaný zapnutý Kalendář. Samotná fáze
`ready` nestačí: popisuje dokončenou kontrolu Kalendáře, nikoli potvrzení
všech místních změn. Čekající změny jsou žluté a mají počet; probíhající
přenos nebo kontrola je modrá. Platné selhání či konflikt je červený.
Vypnuté propojení nebo chybějící přihlášení bez čekajících změn je neutrální.
Položky čekající na jiný účet se nesmí vydávat za synchronizované.

Barvu doplňuje text a odlišná ikona; oba barevné motivy mají vlastní odstíny.
Kontrolka není automaticky oznamovaná po každém přepsání stavu a otáčení
ikony respektuje omezení pohybu. Klikací plocha má minimálně 44 px.

Ověření: celá sada 810 testů, sestavení, lint, kontrakt motivů a protokol
agentů. Testy se skutečnou databází a frontou ověřují čekání, běžící přenos,
potvrzení, selhání a opraveného následníka. Prohlížeč Chrome přes Playwright
se simulovaným Google API ověřil vytvoření schůzky, offline změnu názvu a
času, obnovení připojení, zadrženou odpověď, potvrzený zápis, odmítnutí a
opravu. Žádné informační okno nevyskočilo. Kontrolka byla ověřena na
1440 × 1000 a 390 × 844 v tmavém i světlém motivu; reálný Google účet nebyl
v tomto testu použit.
