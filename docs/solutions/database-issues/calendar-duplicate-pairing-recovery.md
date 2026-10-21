---
title: Duplicitní Calendar vazba blokuje celou synchronizaci
date: 2026-10-21
category: database-issues
module: Google Calendar Sync
problem_type: database_issue
component: database
symptoms:
  - "Jedna Calendar událost má více místních položek."
  - "Poslední kontrola zůstává stará a lokální změny čekají ve frontě"
root_cause: data_integrity
resolution_type: code_fix
severity: high
tags: ["google-calendar", "pairing", "legacy", "duplicates", "outbox", "private-data"]
---

# Duplicitní Calendar vazba blokuje celou synchronizaci

## Problém

Více místních řádků může odkazovat na jednu Google událost. Výjimka při
párování vrátí celou importní transakci zpět a nepovolí doručení uložené
fronty. Oprava je ověřená lokálně; nasazení ani obnova uživatelova účtu
nejsou touto dokumentací potvrzené.

## Příčina

Legacy zálohy nemají přenosné publicId. Import proto zachovává různé
obsahové verze jako samostatné záznamy. Stejnou událost může mezitím
naimportovat Kalendář pod jinou místní identitou. To není důkaz, že jsou
shodné také jejich soukromé poznámky, checklist nebo místní dokončení.

Druhá příčina byla odlišná: přímé hledání zkoušelo potvrzený googleEventId
i historický reservedGoogleEventId. Řádek tak mohl nárokovat dvě různé
události, zatímco sledování a doručování používaly jen první účinný cíl.

## Řešení

`battle-plan/src/services/googleCalendarSync.ts` sjednocuje legacy hledání
na účinný cíl:

```ts
task.googleEventId ?? task.reservedGoogleEventId
```

Ve stejné transakci jako import opravuje prokazatelné duplicitní vazby.
Platná vzdálená private identity musí určit jediného odpovídajícího
vlastníka. Bez ní lze použít jedinou existující moderní vazbu; čistě
legacy kopie vyžadují shodné nenulové veřejné projekce a stav smazání.
Rozporné moderní identity zůstávají odmítnuté.

Ostatní řádky si ponechají obsah, klíče i historii. Metadata duplicateOf
označí vlastníka a suppressed vypne automatické odesílání kopie. Její
čekající Calendar efekty se označí jako superseded; nejde o potvrzení
úspěšného zápisu do Googlu. Outbox i acknowledgement kontrolují marker,
takže ani starý delete nebo pozdní odpověď nezmění původní událost.

## Co nepoužít

Nevyrábět všem legacy řádkům stejné publicId jen podle účtu a události.
Reducer záloh nebo import by následně vybral jedinou celou verzi a mohl
zahodit odlišné soukromé poznámky ještě před opravou vazeb.

Odpojenou kopii nelze pouze obnovit zvýšením generace. Pokud sdílí
canonicalIdentity s vlastníkem, oba by později mohli rezervovat stejný
deterministický cíl. Samostatná událost potřebuje nový místní záznam
s vlastní identitou. Starší záloha nesmí odstranit duplicateOf uvnitř
stejné generace.

## Ověření a prevence

Regrese pokrývají původní hlášku, historickou rezervaci jiné události,
zachování soukromých kopií a tombstones, oba účty, superseded delete,
opakovaný pull, pozdní acknowledgement a rollback nejednoznačné dávky.
Celá sada 822 testů, lint, TypeScript a produkční sestavení prošly.

Izolovaný browser test se skutečným IndexedDB a simulovaným Google API
ověřil zachování obou řádků a soukromých polí, průchod přes 120 přeskočených
zrušení, jediný zápis vlastníka, žádný delete, prázdnou frontu a opakované
obnovení bez dalších zápisů. Produkční panel vykreslil opravenou vazbu
a stav Synchronizováno; konzole byla bez chyb. Reálný Google účet nebyl
tímto testem změněn.

Při změnách párování vždy rozlišovat vlastnictví Google události od
identity místního záznamu. Oprava vztahu nesmí sloučit jeho soukromý obsah.
