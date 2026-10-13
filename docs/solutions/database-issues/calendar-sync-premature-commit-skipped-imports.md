---
title: Calendar sync ztrácí transakci při velké dávce přeskočených importů
date: 2026-10-10
category: database-issues
module: Google Calendar Sync
problem_type: database_issue
component: database
symptoms:
  - "Transaction committed too early. See http://bit.ly/2kdckMn"
  - "Kontrola Kalendáře selže a uložená fronta změn se nedoručí"
root_cause: async_timing
resolution_type: code_fix
severity: high
framework_version: Dexie 4.2.1
tags: [google-calendar, dexie, indexeddb, transactions, async-await, skipped-imports]
---

# Calendar sync ztrácí transakci při velké dávce přeskočených importů

## Problém

Ve verzi 4.3.82 mohla kontrola Kalendáře skončit chybou `PrematureCommitError`
a zablokovat doručení místních změn. Počet čekajících změn sám o sobě nebyl
spouštěčem: samostatná fronta 61 plánů procházela. Rozhodující byla dlouhá
série událostí, jejichž import neprováděl žádnou databázovou operaci.

Oprava je připravena lokálně na větvi `codex/calendar-sync-transaction`;
nasazení ani uživatelův živý Google účet tato validace neověřuje.

## Příčina

`GoogleService.listCalendarEvents` používá `showDeleted: true`, takže list
může obsahovat i mnoho zrušených událostí bez místní položky. V transakci
`GoogleCalendarSync.pull` smyčka bezpodmínečně čekala na `importEvent`.
Metoda byla `async`, a vracela proto nativní Promise i v případech, kdy ihned
skončila: nepatřící zrušená událost, dosud nevytvořený rezervovaný cíl nebo
starší generace události.

Dexie 4.2.1 sleduje kontext nativního async/await pomocí omezeného počtu
microtask echoes. Dlouhá série těchto prázdných čekání bez IndexedDB requestů
vyčerpá sledování transakčního kontextu. Následné pokračování dávky pak může
narazit na předčasně dokončenou transakci. `pull` nepotvrdí readiness pro
doručení a fronta zůstane čekající.

Reprodukce se 100 nepatřícími zrušenými událostmi selhala stejnou hláškou
v Edge se skutečným IndexedDB i v Node s fake IndexedDB. Malé dosavadní
fixtures procházely. Před ověřením bylo nutné použít `npm ci`: lokální
instalace obsahovala Dexie 4.4.4, kdežto `package-lock.json` i CI určují 4.2.1.
Počet 100 je velikost ověřené reprodukce, nikoli veřejný limit API.

## Co nefungovalo

Obalení celého `importEvent` do `Dexie.Promise.resolve` vedlo v tomto řetězci
vnořených transakcí k `TransactionInactiveError`. Stejný problém měl přepis
databázové větve smazání do `.then`, který vracel nativní Promise z `save`.
Tyto varianty byly odstraněny; existující test skutečného smazání je důležitý
vedle nového testu přeskočených událostí.

## Řešení

`importEvent` vrací `Promise<void> | void` a synchronní přeskočení události
skutečně vrací `undefined`. Smyčka čeká jen na skutečnou databázovou práci:

```ts
const imported = this.importEvent(eventId, event, settings, tasks);
if (imported) await imported;
```

Aktivní událost vrací stávající `save`. Větev skutečného vzdáleného smazání
si zachovává původní async/await uvnitř malé async funkce. Importy se dál
provádějí postupně nad společným seznamem úkolů a ve stejné atomické transakci.
HTTP čtení zůstává před transakcí a doručení až po jejím úspěšném dokončení.

## Ověření a prevence

`battle-plan/src/services/googleCalendarSync.test.ts` nyní ověřuje 120
nepatřících zrušených událostí, 61 rezervovaných chybějících cílů, zachování
celé fronty a soukromých poznámek, import další platné události i opakování
bez duplicit. Druhý test ověřuje rollback úkolů, protokolových událostí,
outboxu, efektů a nastavení při neplatné identitě na konci velké dávky.

Ve skutečném IndexedDB v Edge prošly dávky 61, 100, 250, 500 a 1 000
přeskočených událostí. Test s 1 000 přeskočeními a simulovaným Google writerem
doručil všech 61 efektů, potvrdil párování a nula čekajících změn; opakovaný
pull neodeslal nic dalšího. Celá sada 812 testů, lint, TypeScript, build,
theme contract a protokolová konformance prošly.

Při změně importní smyčky zachovat synchronní návrat všech no-op větví
a testovat velké série přeskočení, nejen celkový počet zapisovaných položek.
Neodstraňovat transakci ani readiness gate kvůli potlačení chybové hlášky.

## Související

- [Pozorování před doručením](../integration-issues/calendar-sync-observation-before-delivery.md)
- [Durable Task mutations](../architecture-patterns/durable-task-mutations-and-google-effects.md)
- [Dexie PrematureCommitError](https://dexie.org/docs/DexieErrors/Dexie.PrematureCommitError)
