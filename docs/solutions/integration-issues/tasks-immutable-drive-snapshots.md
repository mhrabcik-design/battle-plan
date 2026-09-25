---
title: Souběžné zálohy úkolů nesmí přepisovat změny jiného zařízení
date: 2026-09-25
category: integration-issues
module: Task Drive backup
tags: [google-drive, tasks, concurrency, immutable-snapshots]
---

# Souběžné zálohy úkolů

## Problém

`TaskDriveBackup.save` přepisoval jediný soubor `battle_plan_data.json` úplným lokálním snapshotem. Dvě zařízení mohla přečíst stejný starý stav a následně jedno přepsalo změny druhého. Lokální koordinátor řeší souběh uvnitř jedné aplikace, nikoli mezi zařízeními.

## Řešení

Nové publikace vytvářejí vždy nový soubor `battle_plan_task_snapshot_v2.json` pomocí `createOnly`. Čtení zahrnuje všechny soubory tohoto názvu i všechny starší soubory `battle_plan_data.json`. Staré soubory se nepřepisují ani nemažou.

Doménový reducer spojuje úkoly přes přenositelné `publicId` a identitu occurrence návrhu. Vítězí nejnovější `updatedAt`, s historickým fallbackem na `createdAt`. `isDeleted` zůstává součástí vítězného záznamu; nepřítomnost úkolu v jiné záloze není smazání. Různé přenositelné identity jedné occurrence zůstávají aliasy, aby pozdější změna bez metadat návrhu neztratila příslušnost k témuž úkolu. Načtení přes `mergeTasksFromDrive` zachová lokální primární klíč a vytvoří jediný úkol.

Rozporné subject/occurrence identity nebo různé obsahy při shodném nejnovějším čase vyvolají chybu. Porovnání obsahu ignoruje lokální databázový klíč, zachovaný čas vzniku na původním zařízení, protokolovou revizi, čítač efektů a lokální vazby doručování do Google. Chybějící historické `updatedAt` se při porovnání normalizuje na efektivní čas verze, aby následný import a záloha nevytvořily falešný konflikt. Historické záznamy bez přenositelné identity zachovává samostatně podle přesného obsahu; existující `taskMerge` jim přidělí deterministickou historickou identitu.

Úspěšná publikace vyžaduje přečtení vytvořeného souboru podle jeho ID, shodu obsahu, přítomnost stejné publikace ve společném seznamu a úspěšnou kontrolu sloučeného stavu. Samotná existence souboru nestačí, pokud jej ostatní klienti ještě nemohou najít. Nastavení prochází explicitním filtrem při zápisu i při načtení.

Při opakovaném ověření stejného obsahu se používá již vytvořené ID, oddělené podle účtu a složky. Po restartu lze znovu použít odpovídající nejnovější neměnnou publikaci. Starší shoda se nepoužívá, protože může jít o záměrný návrat k dřívější předvolbě. Známý konflikt se kontroluje před vytvořením souboru. Pokud se ztratí samotná odpověď uploadu a soubor ještě není v seznamu, jeho totožnost nelze bezpečně zjistit; v tomto případě může vzniknout nadbytečná kopie.

Necitlivé předvolby používají čas snapshotu. Při shodném čase rozhoduje stabilní lexikografické pořadí serializovaného obsahu, takže souběžná změna měřítka UI nebo modelu neblokuje obnovu úkolů.

## Ověření a omezení

Regresní testy pokrývají souběžné publikace ze starých lokálních pohledů, oba historické soubory stejného názvu, novější smazání, konflikty obsahu/identity, lokální revize, historicky chybějící `updatedAt`, filtrování tajných údajů, neshodu uloženého obsahu, chybějící položku v seznamu a import occurrence aliasů na obou původních zařízeních.

Staré verze aplikace nový název nečtou; pro obousměrnou synchronizaci musí být všechna používaná zařízení aktualizovaná. Nový klient nadále umí načíst staré publikace. Snapshoty se kumulují; bezpečná kompaktace vyžaduje vlastní protokol a není součástí této opravy. Stejně časované konfliktní editace se hlásí jako chyba, neřeší se svévolným výběrem vítěze. Síťové chování skutečného Drive musí ověřit integrační zkouška s účtem.

Související: [Neměnné snapshoty WorkLogs](worklogs-immutable-drive-snapshots.md).
