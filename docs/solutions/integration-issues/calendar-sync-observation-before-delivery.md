---
title: Obousměrný Calendar sync potřebuje potvrzené pozorování před doručením
date: 2026-10-09
last_updated: 2026-10-09
category: integration-issues
module: Google Calendar Sync
problem_type: architecture_pattern
component: database
severity: high
applies_when:
  - "Lokální durable fronta musí doručovat změny do obousměrně upravovaného kalendáře"
  - "Aplikace může obnovit staré efekty, změnit účet nebo zaniknout během načítání"
tags: [google-calendar, outbox, reconciliation, foreground, identity, concurrency]
---

# Obousměrný Calendar sync potřebuje potvrzené pozorování před doručením

## Context

Původní Calendar outbox zajišťoval doručení místních změn. Po přidání příjmu
Google událostí může stará čekající změna konkurovat novějšímu obsahu v Googlu.
Samotný bezpečný PATCH ani místní lease neurčují, zda je uložený snapshot stále
platný. To se musí rozhodnout nad společnou verzí a aktuálním pozorováním.

Při implementaci se ukázaly tři méně zřejmé cesty kolem této hranice: okamžitý
drain z editoru, dříve uložený efekt bez nové veřejné projekce a pull, který
načetl API, ale kvůli změně nastavení neprovedl lokální commit. Nový background
controller sám tyto cesty nepokrývá. Základní obousměrné propojení bylo mergnuto
v [PR #69](https://github.com/mhrabcik-design/battle-plan/pull/69).
Úprava jediného přepínače je zatím připravená na implementační větvi;
živý OAuth smoke test zbývá provést na povoleném testovacím originu.

## Guidance

První pozorování je důkaz pro konkrétní živou session, nikoli persistentní
příznak. `calendarDeliveryGate.ts` drží readiness v paměti pro databázi, ověřený
účet, token a foreground stav. Změna session důkaz ruší. Persistentní
`lastCheckedAt` slouží k informování uživatele a nesmí povolit nové doručení.

`googleCalendarSync.ts` nejprve získá celý stránkovaný výsledek a explicitně
načte sledované identity, které ve výřezu chybí. Chybění v listu neznamená
smazání: událost mohla být přesunuta mimo datumové okno. Veškeré API čtení
předchází jedné transakci s novými místními revizemi. Ta znovu kontroluje
session i uložené nastavení a musí skutečně commitnout. Teprve potom může
označit pull jako ready a spustit doručení.

Stejný gate používá background i okamžitý drain v
`externalEffectOutbox.ts`, včetně starých efektů bez projekce. Po úspěšném
pozorování se takový legacy snapshot modernizuje z aktuálního Task a jeho
baseline; nepřehraje se starý název nebo popis přes přijatou Google změnu.
Dosud nevytvořený rezervovaný cíl nemá baseline ani po potvrzeném GET s 404.
Takový místní create se po committed pullu modernizuje ze současného Task a
ponechá rezervované ID. Propojený legacy event bez baseline zůstává blokovaný;
samotná absence baseline proto není správná obecná podmínka pro zastavení FIFO.
Při vypnutí propojení se pozastaví automatické efekty. Explicitní historická
cesta pro ruční Sync si zachovává původní kompatibilitu.

Opětovné zapnutí musí zachytit také veřejné změny již propojených položek.
Editace při vypnuté synchronizaci záměrně nevytváří automatický efekt; samotný
import později zachová místní odchylku od baseline, ale nic neodešle.
`activationOperation` proto kromě nových plánů zařadí změněnou veřejnou
projekci nebo místní smazání propojené položky. Zachová původní identitu a
generaci, vynechá konflikty, readonly a potlačené bloky i jiné účty. Nový záměr
se uloží atomicky s aktivací, případně za starší čekající efekt. Doručení dál
čeká na potvrzený pull; soukromá změna ani nezměněný Google import efekt nevytvoří.

Pozorování a uživatelovo rozhodnutí mají různé hranice. Konflikt už jednou
předložený uživateli se automatickým pullem nezruší. Volba z nastavení nese
revizi a Calendar metadata clock vykreslené verze. `resolveConflict` znovu
načte událost a pod transakcí porovná i aktuální místní stav. Pokud se některá
verze změnila, vrátí `stale` a vyžádá novou volbu nad aktuálním konfliktem.

## Why This Matters

Uložený čas poslední kontroly může vypadat aktuálně, přestože patří minulému
tokenu či účtu. Úspěšná HTTP odpověď také nestačí: transakce může záměrně
neproběhnout. Považovat kterýkoli z těchto stavů za ready by dovolilo staré
frontě doručit obsah dřív, než se rozpozná souběžná Google změna.

Společná veřejná baseline obsahuje název, veřejný popis a atomický interval.
Interní poznámky, checklist a lokální dokončení se tím nerozhodují. Google
hosté, RSVP, Meet, místo a připomínky zůstávají mimo exportní projekci.
Tato omezená množina umožňuje bezpečně sloučit různá změněná pole a zastavit
spor stejného pole; nerozhoduje se podle samotného timestampu.

## When to Apply

Tento postup platí pro foreground synchronizaci primárního kalendáře. Jediné
zaškrtnutí synchronizace zařadí všechny způsobilé stávající místní plány bez
výběru položek nebo dat. Nové změny se přenášejí automaticky. U dříve zapnutého
propojení se vynechané nepárované plány doplní při potvrzeném pullu; původní
`enrolledPublicIds` se zachovávají pouze kvůli kompatibilitě uložených nastavení.
Zrušené bloky, nativní Google Tasks a položky jiného účtu se tím neobnovují ani
nepřenášejí. Deterministické cíle nepárovaných plánů se před zařazením ověřují,
takže ani existující událost mimo časové okno nevytvoří druhé párování.
Google import se posouvá s dneškem o 30 dní zpět a 180 dopředu;
sledované identity mimo okno se ověřují samostatně. Zavřená aplikace nepracuje
jako server a native Google Tasks zůstávají samostatnou integrací.

## Examples

`battle-plan/src/services/googleCalendarSync.test.ts` ověřuje selhání prvního
pullu, neprovedený commit při disable, account switch, remount, legacy drain,
posun sledované události mimo okno a změnu konfliktu mezi vykreslením a volbou.
Pokrývá také vypnutí, místní editaci a opětovné zapnutí se skutečným doručením,
starší čekající záměr před novějším a rollback celé aktivace při chybě druhého efektu.
`battle-plan/src/services/externalEffectOutbox.test.ts` pokrývá pozdní
acknowledgement a ETag preconditions. HTTP fixtures a fake IndexedDB dokazují
tyto hranice bez soukromého účtu; nenahrazují živý test Google oprávnění.

Při další úpravě koordinace zachovat test neprovedeného commitu: úplný API
výsledek, disable před transakcí, žádný lokální import a žádný povolený export.
Jde o odlišný scénář od síťové chyby a snadno se ztratí při refaktoru.

## Related

- [Lokální fencing a remote preconditions](../architecture-patterns/durable-task-mutations-and-google-effects.md)
- [Přijatý implementační plán](../../plans/2026-10-09-0851-feat-google-calendar-two-way-sync-plan.md)
