# Ověření úprav plánování — 18. 9. 2026

Výchozí stav: verze **4.3.70**, commit `5f28fa882c19e9c44a713d942f650e2095a517c8`.
Obnova: vzdálený tag `backup/pre-uplift-2026-09-18-2009`; úplný ověřený Git bundle,
ZIP zdrojů, SHA-256 a postup obnovy jsou ve vedlejším adresáři
`../battleplan-backup-2026-09-18-2009/`. Záloha zachycuje kód a původní lokální
pracovní soubory, nikoli obsah prohlížečové databáze nebo Google účtu.

## Výsledek

Přehled otevřené práce, hledání bez diakritiky a ruční založení přes stávající
editor zkracují běžné ovládání. Karty mají čitelnější hierarchii a pořadí akcí
odpovídající klávesnici. Mobilní navigace reaguje na první klepnutí; při získání
fokusu už neposouvá tlačítko pod prstem.

Opravy dat pokrývají ztracené hlasové podúkoly, vyčištění času, ochranu rozepsaného
editoru, import podle přenosné identity a návrhu, nezávislé zálohování všech dat
a souběžné spouštění pollingu. Dnešní kontext čte WorkLogs přes existující index
s limitem deseti řádků.

## Automatické kontroly

| Kontrola | Před | Po |
|---|---:|---:|
| Testy | 400 prošlo | 429 prošlo |
| ESLint | prošel | prošel |
| Kontrola motivů | prošla | prošla |
| TypeScript + Vite + PWA build | prošel | prošel |
| Vstupní JS, minifikovaný | 683,86 kB | 633,52 kB |
| Vstupní JS, gzip | 215,22 kB | 202,48 kB |

Menší vstupní balík není tvrzení o stejně velkém zrychlení na zařízení. Vite
stále hlásí balík nad 500 kB a původní kombinaci statického a dynamického importu
Drive store. Celkový PWA precache se rozdělením obrazovek automaticky nezmenšuje.

Nový workflow `Validate pull request` spouští čisté `npm ci`, lint, theme check,
testy a build na Node 24 už před sloučením. Nepublikuje aplikaci ani nezvyšuje verzi.

## Prohlížeč

Testová data byla umělá, lokální a bez Google přihlášení. Vývojový regresní běh
v Chrome pokryl hledání, filtry, N/Ctrl+K/Escape, validaci prázdného názvu,
zrušení bez zápisu, dvojklik bez duplicitního založení, reload, dokončení při
rozepsaném názvu a týdenní přesun klávesnicí s Undo. Bez neočekávaných page errors.

Závěrečný CE průchod použil vestavěný prohlížeč. Izolovaný lokální proxy server
zdržel a poté odmítl import editoru; čekající dialog držel fokus, šel zavřít,
chyba nabídla obnovu a po obnovení se editor znovu otevřel. Regrese přechodu
pending → načtený editor → zavření byla nejprve reprodukována (fokus na body)
a po opravě vracela fokus na původní tlačítko.

| Pohled / scénář | Výsledek |
|---|---|
| Plán, Úkoly, Schůzky, Myšlenky | PASS — hledání, kontextové založení, seznamy |
| Týden | PASS — načtení, klávesnicový přesun a Undo |
| Práce | PASS — načtení lokální obrazovky a ovládacích prvků |
| Návrhy | PASS — korektní stav bez přihlášení |
| Nastavení | PASS — lazy načtení, motiv, zavření |
| Editor | PASS — tvorba, ochrana změn, pomalý/chybný import, fokus |
| Mobil | PASS — 320/390 px bez vodorovného přetečení dokumentu; první klepnutí na záložku |
| Motivy a klávesnice | PASS — světlý/tmavý náhled, omezení pohybu, pořadí akcí |
| Skutečné OAuth, Google zápisy, záznam hlasu a Gemini | SKIP — bez účtu, klíče a mikrofonního vstupu v izolovaném QA |

Při úmyslně odmítnutém importu vznikly očekávané logy ErrorBoundary. Nejde o
chybu běžné navigace. U nativního date inputu bylo datum ověřeno také klávesnicí:
samotný `fill` vestavěného QA ovladače nezpůsobil React změnovou událost.

## Revize a omezení

CE plán, provedení, simplify a code review doplnily zásady Ponytail: bez nové
knihovny, schématu nebo druhého editoru. Review našlo a ověřilo tři opravené
regrese: unique identitu návrhu při importu, pořadí Tab na kartě a návrat fokusu
po lazy načtení. Samostatný reviewer a validator poskytli nezávislé kontroly;
ostatní pohledy běžely inline kvůli limitu agentů. Cross-model review se
nespustilo kvůli chybějícímu `jq` ve WSL.

Souběžné nahrazení celého task snapshotu z více zařízení zůstává otevřené.
Lokální fronta zápisů není vzdálené řešení konfliktů. Nejasné legacy snapshoty
bez identity mohou vytvořit oddělené záznamy; přednost má zachování obsahu před
tichým přepsáním jiného úkolu. Rozporné identity návrhu import výslovně zastaví
s rollbackem. Produkční externí integrace nebyly v tomto běhu koncově ověřeny.
