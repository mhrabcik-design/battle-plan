# Studie proveditelnosti: Battleplan ↔ Google Kalendář

Datum: 9. 10. 2026. Stav: studie, návrh k rozhodnutí před implementací.
Podklad: aktuální zdrojový kód na commitu `bd28a630a948aeae0fdfe80ecc19f790a978aa1c`, dokumentace projektu a oficiální dokumentace Google. Závěry vycházejí ze statické kontroly; přístup do konkrétního Google účtu ani živý přenos nebyly testovány.

## Závěr

**Ano, obousměrný přenos je technicky proveditelný.** Google Calendar API umožňuje načítat, vytvářet, upravovat a mazat události. Battleplan již má přihlášení ke Googlu a odchozí zápisy do Kalendáře. Hlavní nová práce spočívá v příchozí synchronizaci, párování záznamů a řešení souběžných změn.

Doporučuji první etapu zachovávající dnešní statickou PWA: schůzky a naplánované úkoly se synchronizují při používání aplikace, po návratu do ní a po obnovení připojení. **Trvalý běh při zavřené aplikaci vyžaduje serverovou službu a další úložiště.** To je samostatná architektonická etapa.

Zároveň je nutné rozlišit běžnou kalendářovou událost a Google Task. Úkoly s přesným časem a délkou doporučuji přenášet jako kalendářové bloky. Nativní Google Tasks mohou zůstat druhým podporovaným zdrojem, ale jejich API nepřenáší čas naplánování. [Calendar Events](https://developers.google.com/workspace/calendar/api/v3/reference/events), [Google Tasks](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks).

## Co už v projektu existuje

| Oblast | Ověřený stav | Důsledek |
| --- | --- | --- |
| Google přihlášení | `googleService.ts:87` žádá `calendar.events`, Drive a profil; Google Tasks jsou volitelné oprávnění. | `calendar.events` již umožňuje čtení i zápis událostí. Pro základní import není potřeba nové Calendar read oprávnění. |
| Schůzky do Googlu | Editor a hlasový tok při použitelném přihlášení mohou vytvořit odchozí efekt pro novou schůzku. Propojené záznamy se následně aktualizují. | Odchozí část lze rozšířit, nebuduje se od začátku. |
| Úkoly do Kalendáře | Existuje explicitní akce synchronizace i pro lokální úkol. Běžný nový nepropojený úkol se automaticky neexportuje. | Pro požadované chování je nutná jednotná politika automatického exportu. |
| Fronta zápisů | `taskMutations.ts` a `externalEffectOutbox.ts` ukládají změnu i efekt atomicky, rezervují ID, kontrolují účet a opakují neúspěšné pokusy. | Využít současnou frontu a zachovat její záruky. |
| Ochrana Google polí | `googleService.ts:707` používá GET + PATCH/DELETE s ETag a `If-Match`; hosté, místo a Meet zůstávají zachované. Interní poznámky se neexportují. | Důležitý základ pro synchronizaci schůzek s pozvánkami. |
| Google Calendar do Battleplanu | Není implementováno načítání kolekce událostí, synchronizační tokeny ani příchozí koordinátor. GET konkrétní události slouží odchozím zápisům a otevření pozvánky. | Toto je hlavní chybějící funkce. |
| Google Tasks do Battleplanu | `useGoogleTasks.ts` načítá vybraný seznam; `App.tsx:342` jej mapuje do zobrazení. Úpravy, datum, dokončení a smazání těchto položek mohou zapisovat zpět. | Jde o částečnou samostatnou integraci, nikoli import běžného Google Kalendáře. Zobrazené položky nejsou plnohodnotnou lokální offline kopií. |
| Nasazení | `deploy.yml` publikuje statické `dist/` na GitHub Pages. Data žijí v IndexedDB a Google Drive. | Dnešní aplikace nemá proces běžící po zavření prohlížeče. |

Dokument `docs/ROADMAP.md` zmiňuje přidání read scope, ale aktuální `calendar.events` již čtení zahrnuje. Nové `calendar.calendarlist.readonly` by bylo potřeba při zavedení výběru z uživatelových kalendářů. Současné zápisy míří natvrdo do `primary`. [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

Relevantní projektové podklady: `docs/ARCHITECTURE.md`, `docs/PRODUCT.md`, `docs/solutions/architecture-patterns/durable-task-mutations-and-google-effects.md` a `docs/solutions/integration-issues/google-tasks-scope-403-background-fetch-2026-07-06.md`. Historický plán opravy Drive synchronizace také dokládá dosavadní preference zachovat GitHub Pages bez backendu; tato studie ji používá jako výchozí doporučení.

## Jak se mají položky přenášet

| Položka | Doporučené mapování | Omezení |
| --- | --- | --- |
| Schůzka v Battleplanu | Jedna Google událost se stejným názvem, veřejným popisem, začátkem a koncem. | Hosté a RSVP se dál spravují v Googlu. |
| Naplánovaný úkol s časem | Google událost jako blok práce. | Dokončení úkolu nemá v běžné události přímý ekvivalent. |
| Úkol s datem bez času | Celodenní událost, pokud má být zahrnut do kalendářové synchronizace. | Termín splnění a datum plánovaného bloku nejsou vždy stejná informace. |
| Úkol bez skutečného plánu | Zůstává v Battleplanu; případně lze zvolit export do Google Tasks. | Automaticky mu nevymýšlet čas 09:00 nebo dnešní datum. |
| Nová událost vytvořená v Googlu | Import jako schůzka, s možností uživatelem změnit typ na úkol. | Google u běžné události spolehlivě neoznačuje, zda jde o práci nebo schůzku. |
| Google Task | Zachovat existující cestu přes Tasks API; při rozšíření přidat lokální kopii a spolehlivé párování. | API poskytuje datum a stav dokončení, nikoli přesný čas naplánování nebo délku bloku. |

U úkolů přenášených jako událost zůstává dokončení v Battleplanu. Smazání pracovního bloku v Googlu samo o sobě nesmí označit úkol jako hotový ani odstranit jeho obsah. Doporučený význam je odstranění plánu/propojení s blokem a potlačení jeho automatického opětovného vytvoření. Nativní Google Tasks naopak umožňují obousměrně přenášet stav dokončení. [Tasks resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks).

V první etapě neexportovat tentýž úkol současně jako událost i jako Google Task: vedlo by to ke dvěma položkám v Google UI a dvěma odlišným stavovým modelům. Automatický import externí události nesmí sám vytvářet novou kopii této události v Googlu.

### Důležitá odlišnost času

`calendarUtils.ts:186` chápe `startTime` u úkolu jako **konec** pracovního bloku, u schůzky jako **začátek**. `googleService.addToCalendar()` dnes chápe toto pole vždy jako začátek.

Příklad: úkol má `startTime = 15:00` a `duration = 60`. Týden Battleplanu zobrazuje 14:00–15:00, dnešní export vytvoří 15:00–16:00. Před automatizací je nutné sjednotit převod oběma směry a určit migraci již propojených úkolů.

Úkoly také používají především `deadline`; export dnes upřednostňuje `date`. `ensureTaskDeadline()` navíc může doplnit datum automaticky. Pro integraci je proto potřeba určit, co je skutečně naplánované, a oddělit čas bloku od termínu splnění. Google Tasks `due` představuje datum naplánování, nikoli samostatný deadline; současné mapování do obou lokálních polí tento rozdíl ztrácí. [Tasks resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks).

## Dvě proveditelné architektury

| Vlastnost | A: synchronizace v PWA | B: serverová synchronizace |
| --- | --- | --- |
| Nový server | Není nutný. | Serverless služba nebo backend s HTTPS. |
| Během používání | Automatický import a export, tlačítko pro ruční obnovení. | Totéž, s centrálním koordinátorem. |
| Při zavřené aplikaci | Změny v Googlu se převezmou po otevření. Lokální čekající exporty čekají na běh aplikace. | Server přebírá změny i bez otevřeného klienta; pro odeslání změny musí nejprve dostat její data. |
| Přihlášení | Dnešní browser token model; při vypršení může být potřeba zásah uživatele. | Authorization code flow s offline přístupem a bezpečně uloženým refresh tokenem. |
| Více zařízení | Vyžaduje přenos stabilních identit a kontrolu konfliktů s existujícím Drive merge. | Centrální fronta a verzované úložiště usnadní koordinaci. |
| Provoz | Zachování GitHub Pages; žádný nový hosting synchronizační služby. | Hosting, úložiště, obnova webhooků a dohled. |

**A doporučuji jako první etapu.** Obnovování např. každých 60 sekund je návrhový interval při aktivní viditelné aplikaci, nikoli garantovaná odezva: prohlížeč může pozadí uspat a token vypršet. Přidat obnovení při otevření, návratu na kartu, návratu online a ruční akci. Současné pokusy o tichou obnovu tokenu nezaručují neomezený přístup. [Google token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model).

**B je potřeba, pokud požadavek znamená nepřetržitou synchronizaci i při zavřené aplikaci.** Google může posílat oznámení na HTTPS webhook, ale ten obsahuje jen signál změny; data se musí dočíst přes API. Kanály se obnovují a periodická kontrola kryje vynechaná oznámení. [Push notifications](https://developers.google.com/workspace/calendar/api/guides/push).

Backend navíc nemůže přímo měnit IndexedDB ve vypnutém telefonu. Musí mít sdílené úložiště změn, které Battleplan načte po otevření. Je nutné navrhnout jeho návaznost na současné Drive snapshoty, aby nevznikly dva soupeřící zdroje dat. Samotný webhook bez této datové cesty požadavek nesplní.

Pro B se klientský secret a refresh token ukládají serverově, ne do Vite bundle. Odvolané oprávnění vyžaduje opětovné připojení. U externího OAuth projektu v režimu Testing refresh token s Calendar scopes standardně expiruje za 7 dní; pro trvalý provoz ověřit publikační stav a případnou potřebu verifikace. Konfigurace konkrétního Google Cloud projektu zatím ověřena nebyla. [Server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

## Podmínky spolehlivé synchronizace

1. **Stabilní propojení.** Uchovávat ověřený účet, skutečné `calendarId`, `eventId`, lokální `publicId` a typ položky. Doplnit soukromé `extendedProperties` do BP události pro obnovení vazby a rozlišení úkolu od schůzky. Sufix `[BP]` není spolehlivá identita. Nové události mají dostat deterministické ID odvozené z přenositelné identity a cílového kalendáře, aby dva klienti současně nevytvořili dvě kopie. Migrace zachová již přidělená Google ID. [Event metadata and IDs](https://developers.google.com/workspace/calendar/api/v3/reference/events).
2. **Třístranné porovnání.** Uchovávat poslední synchronizovaný základ společných polí. Porovnávat základ, lokální změnu a aktuální Google verzi; různá změněná pole lze sloučit, konflikt stejného pole zobrazit k rozhodnutí. Samotné porovnání `updatedAt` nestačí. Současný GET čerstvého ETag + PATCH chrání závod během HTTP operace, ale sám neodhalí, že starý lokální snapshot přepisuje dřívější editaci v Googlu. Při 412 znovu vyhodnotit konflikt, ne slepě opakovat starý payload. [Conditional updates](https://developers.google.com/workspace/calendar/api/guides/version-resources).
3. **Oddělit import a odchozí efekty.** Příchozí změny ukládat přes doménovou transakční vrstvu bez automatického odchozího efektu. Současné `importTask()` má nulové efekty, ale timestampové slučování a převzetí celého záznamu nejsou dostatečný Calendar merge. Příchozí veřejný popis nesmí odstranit interní poznámky, checklist, urgentnost ani lokální dokončení.
4. **Smazání a offline změny.** Zpracovat explicitní `cancelled` události a lokální tombstones. Zmizení ze stránky výsledků, rozsahu dat nebo nedostupnost API nejsou důkaz smazání. Zrušení schůzky na jedné straně a současná neodeslaná úprava na druhé vyžadují konflikt. Starý čekající export nesmí obnovit událost smazanou uživatelem v Googlu.
5. **Rozsah importu a úplnost.** Pro první etapu lze načítat celé stránkované časové okno, např. 30 dní zpět a 180 dní dopředu, plus ověřovat propojené události podle ID, i když se přesunuly mimo okno. Pozdější inkrementální cache použije `nextSyncToken`; token potvrdit až po zpracování všech stran. `timeMin`, `timeMax` a filtry soukromých metadat nelze kombinovat se `syncToken`. Při HTTP 410 obnovit Google cache a token, zachovat vlastní úkoly a čekající změny. [Incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync), [List restrictions](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).
6. **Opakování, více dní a cizí pozvánky.** Současný Task model nepopisuje opakování ani konečné datum vícedenní události. Pro první etapu zobrazovat opakované výskyty a vícedenní události pomocí rozšířené kalendářové projekce; jejich editaci otevírat v Googlu. Nevytvářet z každého dne samostatnou editovatelnou schůzku. U pozvánek cizího organizátora nejprve podporovat zobrazení; současný odchozí adapter jejich úpravu odmítá. Plné úpravy sérií vyžadují další datový a UI návrh. [Recurring instances](https://developers.google.com/workspace/calendar/api/guides/recurringevents).
7. **Časová pásma a vlastnictví polí.** Ponechat původní časové pásmo a přesné start/end, správně zacházet s přechodem letního času a exkluzivním koncem celodenní události. Nezaokrouhlovat import na 15 minut jen kvůli drag rozhraní. Zachovat hosty, Meet, místo a připomínky upravené v Googlu; dnešní adapter připomínky znovu nastavuje, takže i jejich vlastnictví je nutné rozhodnout.
8. **Více klientů.** Párování a migrační pravidla musí fungovat přes Drive backup/restore, nikoli pouze na jednom zařízení. Staré otevřené verze aplikace mají dnešní odchozí chování a mohou změny z Googlu znovu přepsat; při nasazení je nutné zajistit aktualizaci klientů. Konflikty odchozí fronty jsou dnes řazeny lokálně, ne globálně mezi zařízeními.

## Doporučená první etapa

Začít primárním kalendářem připojeného účtu. Importovat běžné Google události jako schůzky a automaticky přenášet nové i upravené BP schůzky a naplánované úkoly. Existující historii při prvním zapnutí nepřevést hromadně bez náhledu rozsahu; nejprve nabídnout datumový rozsah a výběr položek.

Naplánované úkoly přenášet jako události, protože tak lze zachovat jejich časový blok. Google Tasks ponechat odděleně a nezdvojovat export. Opakované a vícedenní události zobrazovat, ale editaci v první etapě vést do Google UI. Přidat stav poslední kontroly, čekajících změn, konfliktu a potřeby opětovného přihlášení.

Technicky rozšířit `googleService.ts`, data a indexy v `db.ts`, přidat mapovací a slučovací službu a koordinátor importu na úrovni App. Upravit `taskMutations.ts`, outbox a všechny vstupy změn — editor, hlas, týdenní přesuny a resize, vytvoření z návrhů a obnovu dat. Zkontrolovat přenos nových metadat v Drive zálohách. Nový obecný synchronizační framework není pro A potřeba.

Před dodáním ověřit zejména: vytvoření oběma směry bez duplicit; přesun a prodloužení oběma směry; úkol 14:00–15:00; celodenní a opakované události; smazání versus offline editaci; změnu účtu během požadavku; zachování interních poznámek a hostů; dva klienty upravující tutéž položku; ztracenou odpověď po úspěšném insertu; import mimo pracovní hodiny a posun mimo původní okno. Vedle testů je potřeba živá kontrola s vlastním Google účtem.

## Náročnost a provoz

Předběžný odhad pro jednoho vývojáře: **5–10 pracovních dní pro A** v uvedeném omezeném rozsahu, včetně migrace, testů a živé kontroly. **Dalších 8–15 dní pro B**, podle volby úložiště a změn přihlašování. Plná editace opakovaných sérií a sjednocení native Tasks s časovými bloky jsou další práce. Jde o orientační odhad ze statické studie, ne závazný termín.

U A nepřibude hosting synchronizační služby. Počet API volání je třeba regulovat, respektovat kvóty a opakovat chyby se zvyšující se prodlevou. Google v roce 2026 změnil model kvót a uvádí denní hranici zpoplatnění; konkrétní limity stávajícího projektu je nutné zkontrolovat v Cloud Console. Pro jednoho uživatele s řízeným pollingem očekávám nízké využití, ale studie neslibuje trvale bezplatné API. U B přibudou náklady zvoleného hostingu a úložiště. [Current Calendar quotas and billing threshold](https://developers.google.com/workspace/calendar/api/guides/quota).

Před implementací je potřeba uzavřít tři produktové volby: zda musí sync běžet při zavřené aplikaci; zda mají být BP úkoly časovými bloky nebo nativními Google Tasks; a zda stačí primární kalendář. Doporučení této studie je **A + časové bloky + primární kalendář**, s jasně uvedenými hranicemi. Pokud je trvalý běh součástí požadavku, navrhnout B už od začátku.
