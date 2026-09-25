# Architektura

## Přehled

Bitevní Plán je klientská React PWA bez vlastního backendu. Stav uživatelského rozhraní skládá `src/App.tsx`, trvalá lokální data ukládá Dexie do IndexedDB a externí synchronizaci zajišťují Google API služby v prohlížeči.

## Vrstvy

| Vrstva | Hlavní cesty | Odpovědnost |
| --- | --- | --- |
| Shell a obrazovky | `App.tsx`, `pages/` | Navigace, skládání pohledů a propojení domén |
| UI komponenty | `components/` | Editace, karty, kalendář, nastavení, WorkLogs |
| Orchestrace | `hooks/` | Hlas, Drive sync, diagnostika, příkazy a polling |
| Doménové služby | `services/` | Gemini, Google API, Drive JSON store, sync a agent bridge |
| Data | `db.ts`, `types.ts` | Dexie schema v19 a sdílené datové kontrakty |
| Čistá logika | `utils/` | Kalendář, normalizace, merge identity a diagnostika |

`App.tsx` zůstává kompoziční shell. Sekundární obrazovky Návrhy, Práce a Diagnostika se načítají lazy; `Suspense` řeší stav načítání a `PageErrorBoundary` izoluje chybu chunku od zbytku aplikace. Pokud lazy obrazovka vlastní sdílený zdroj, například WorkLogs mikrofon, vlastnictví určuje vybraný pohled a chybějící controller znamená „zatím nepřipraveno“, ne přechod do jiné domény.

## Datový model

Dexie databáze `BattlePlanDB` má v aktivním schématu v19 tyto skupiny tabulek:

- `tasks`: task / meeting / thought, soft delete, Google identity a audit agentních zápisů;
- `settings`: uživatelská konfigurace;
- `projects`: aktivní a soft-deletované projekty;
- `workLogs`: odpracované činnosti se stabilním `syncId`;
- `agentInbox`: lokální zrcadlo příkazů a jejich výsledků;
- `workLogDeletionTombstones`: trvalé záznamy smazaných WorkLog identit;
- `suggestionSubjects`, `suggestionOccurrences`, `suggestionDecisions`: identita návrhů a trvalý registr rozhodnutí;
- `agentCommandReceipts`, `agentCommandReceiptHistory`, `agentCommandConflicts`: evidence příkazů, historie a konfliktů;
- `agentEventStreams`, `agentProtocolEvents`, `agentProtocolOutbox`: streamy událostí a fronta protokolových zpráv;
- `agentProtocolEffects`: trvalá fronta Google efektů s pořadím podle úkolu, stavem a časem dalšího pokusu;
- `agentConsumerStates`, `agentSigningKeyRefs`, `agentPairingKeys`, `agentReceiverCapabilities`: stav příjemců, párování a schopností protokolu.

Starší verze schématu zůstávají v `db.ts` pouze kvůli migraci existujících IndexedDB instalací. Nejsou to paralelní runtime implementace.

## Hlavní toky

### Plánovací hlas

`useAudioRecorder` → `useGlobalVoiceProcessing` → `geminiService` → `semanticEngine.normalizeEntity` → Dexie. U schůzky může následovat zápis do Google Calendar.

### Hlas pro Práci

`WorkLogVoiceBar` → `workLogExtractor` → `WorkLogVoiceConfirm` → Dexie → `workLogsSync`. Extrakce a validace jsou oddělené od obecného task promptu.

### Google a Drive

`googleService` vlastní OAuth stav, API klienty a jedinou single-flight bránu pro obnovu tokenu. Všechny Drive consumery obnovují přístup přes tuto bránu, takže souběžné požadavky nesmějí spustit více GIS refreshů.

`DriveJsonStore` poskytuje společný mechanismus pro práci s JSON soubory; doménové služby `taskDriveBackup`, `workLogsSync`, `suggestionsSync` a `agentBridge` vlastní tvar payloadu, merge a chybový význam. Sdílené diagnostické helpery převádějí technické stavy Drive až na hranici hooku/UI a zachovávají rozdíl mezi chybějícím volitelným souborem, nedostupným úložištěm a skutečnou chybou.

Návrhy načítají soubor odpovědí jednou za refresh a seskupují jej lokálně. `suggestionsSync` vrací detailní výsledek čtení; při přechodné chybě stránka zachová poslední úplný snapshot, aby přijetí návrhu neztratilo dříve načtené poznámky.

### Týdenní plánování

`WeeklyCalendar` převádí pointer gesto jen na sémantický cíl `{ date, lane, blockTopMinutes }`. Čisté helpery v `calendarUtils` z něj vytvoří plánovací patch se správným významem času pro úkol nebo schůzku. `useTaskCommands` používá `taskMutations`: změna úkolu, revize, bezpečná událost a požadované Google efekty se ukládají atomicky v jedné Dexie transakci. `externalEffectOutbox` následně doručuje efekty do Google Tasks nebo Calendar. Gesto zadá změnu až po dokončení, nikoli během pohybu; síťové doručení může bezpečně opakovat pokus.

Splněné úkoly zůstávají ve stejné tabulce a týdenní live query je vrací podle jejich plánovaného `deadline`. Cleanup používá index `updatedAt` a fyzicky odstraňuje jen staré soft-delete tombstones; stav `completed` není retenční důvod ke smazání. Selhání volitelné Google synchronizace nezahodí lokální přesun a je uživateli oznámeno; efekt zůstává v trvalé frontě pro opakované doručení. Fronta váže požadavek na Google účet, zachovává pořadí pro jeden úkol a chrání potvrzení vlastnictvím lease. Doručování běží při otevřené aplikaci; nejde o globální pořadí mezi zařízeními. Calendar používá podmíněné PATCH/DELETE s ETag a neposílá interní poznámky. Viz [trvalé mutace a Google efekty](solutions/architecture-patterns/durable-task-mutations-and-google-effects.md).

### Diagnostika

`useSyncDiagnostics` drží stav jednotlivých subsystémů. Obrazovka v `pages/DiagnosticsPage.tsx` dostává jen prezentační kontrakt; API klíč přes hranici stránky nepřechází, pouze jeho již připravená koncovka. Build identity z `utils/buildInfo.ts` je při buildu naplněná z `package.json`, času buildu a commitu.

## Sdílené hranice

- Opakované převody chyb používají `utils/errors.ts`.
- Stav OAuth používá sdílené predikáty z `types.ts`; komponenty nemají skládat vlastní varianty `SIGNED_OUT` / `OFFLINE_AUTH`.
- Měsíční navigace WorkLogs a seskupování odpovědí Návrhů jsou čisté helpery s přímými testy.
- Doménový controller je schopnost registrovaná po mountu, nikoli signál vlastnictví pohledu.
- Historické Dexie migrace zůstávají v `db.ts`; jejich odstranění by rozbilo existující instalace.

## Build a nasazení

`vite.config.ts` nastavuje base path `/battle-plan/`, PWA manifest a build-time konstanty. Workflow `.github/workflows/deploy.yml` na `main` automaticky zvýší patch verzi, spustí lint, testy a build a nasadí Pages artifact. Tag `vX.Y.Z` určuje explicitní major nebo minor release.

## Ověření

- `npm run lint`: statická kontrola React/TypeScript pravidel;
- `npm test`: automaticky objevené `src/**/*.test.ts` Node testy s `fake-indexeddb` nad doménovou a integrační logikou;
- `npm run check:theme`: kontrola kontraktu motivů;
- `npm run test:agent-protocol`: shoda generovaných validátorů, protokolové testy a nezávislé konformační případy;
- `npm run build`: TypeScript + Vite + PWA produkční bundle.

Známý technický dluh a další směry jsou v [ROADMAP.md](ROADMAP.md), ne v tomto popisu současného stavu.
