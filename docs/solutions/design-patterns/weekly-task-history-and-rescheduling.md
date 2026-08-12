# Týdenní přesouvání a trvalá historie úkolů

## Kontext

Týdenní přehled potřebuje současně přímé plánování, reaktivní lokální stav a volitelné Google side effecty. Splněný úkol přitom není odpad ani nový historický objekt: je to stále tentýž naplánovaný záznam.

## Vzor

- UI gesto produkuje sémantický cíl, nikdy pointer souřadnice pro perzistenci nebo agentní protokol.
- Čistý převod rozlišuje význam času: schůzka na `startTime` začíná, blok úkolu na něm končí.
- Doménový command uloží lokální změnu právě jednou po dropu a teprve potom provede volitelný vzdálený update.
- Splnění mění `status` stejného řádku. Týdenní query ho nefiltruje a cleanup jej nemaže jen kvůli stáří.
- Soft delete má přednost před historií dokončení; staré tombstones lze čistit přes indexovaný retenční dotaz.

## Google hranice

Google Tasks zůstávají celodenní a datum se posílá jako RFC 3339 `due`. Seznam je nutné načíst přes všechny `nextPageToken`. U celodenní Calendar události se exkluzivní konec počítá přičtením jednoho civilního dne k `YYYY-MM-DD`, ne převodem lokální půlnoci přes UTC.

Lokální stav zůstává autoritativní, když volitelný Google update selže, a chyba musí být viditelná. Automatická konvergence vyžaduje samostatně navržený trvalý outbox; nesmí být předstírána tichým retry v UI.

## Ověření

Nejvyšší hodnotu mají testy čistého převodu času, retention predikátu, stránkování Tasks a civilní datumové aritmetiky. Reálný prohlížeč navíc ověřuje click-versus-drag, zrušení dropu, historické zobrazení a dokončení z detailu.
