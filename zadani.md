# Projekt: Bitevní Plán - Desktop Transformation & Sync

## Stav
✅ Zvětšení pracovní plochy dokončeno.
✅ Adaptivní grid (1-4 sloupce) aktivní.
✅ AI Indikátor (Klíč + Online) implementován.
✅ Škálování UI (Font Slider) funkční.
✅ Multipart Google Drive Sync opraven (mobil i PC).

## Cíl
Transformovat aplikaci z "mobilu v prohlížeči" na profesionální **Desktop-First aplikaci** s hlubokou integrací do Google ekosystému.

## Požadavky (Aktualizováno - Desktop Evolution Phase 2)

1. **Sjednocení úkolů (Task Merging):**
   - Zrušit rozdělení na "Úkoly" a "G-Úkoly".
   - V sidebaru bude pouze jedna kategorie "Úkoly".
   - Systém se bude chovat jako sjednocený seznam, kde jsou lokální úkoly i Google Tasks na jednom místě (odlišené např. ikonou).
   - Sync s Google Tasks probíhá na pozadí.

2. **Vylepšený Týdenní Kalendář (Timeline View):**
   - **Header Layout:** Lišta s měsícem a navigací (Dnes, <, >) integrována do hlavního záhlaví mezi název sekce a datum.
   - **Vertikální Časová Osa:** Časová osa od **07:00 do 19:00**.
   - **Dynamické Sloupce:** Sloupce dnů se roztahují dynamicky až dolů na konec stránky bez vnějšího scrollování stránky.
   - **Pozicování dle Času:** Schůzky a úkoly s časem se zobrazují na příslušném místě v časové ose.
   - **Indikátor Aktuálního Času:** Červená linka ukazující aktuální čas.
   - **Vizuální Styl:** Profesionální "office" look, indigo pro schůzky, tmavý/oranžový styl pro úkoly. Víkendy (sobota, neděle) jsou vizuálně odlišeny tmavším pozadím sloupců.

3. **Maximalizovaná Editace (Focus Mode):**
   - Při rozkliknutí úkolu nebo meetingu se otevře editační okno dynamicky přes celou obrazovku (Focus Mode).
   - Cílem je maximalizovat prostor pro psaní a editaci textu (text-area přes většinu šířky).
   - Odstranit zbytečné okraje a "mobilní" mezery.

4. **Desktop Layout & Mezery:**
   - Celkový vzhled působí jako nativní profesionální PC aplikace (Desktop-First).
   - Minimalizovat mezery (paddingy/gaps) mezi panely pro maximální využití pracovní plochy.

5. **Nové Urgentnosti (3 stupně):**
   - Zjednodušení priorit na 3 stupně (1, 2, 3).
   - **3 - Urgentní:** Nejvyšší priorita.
   - **2 - Normální (Default):** Pokud není zmíněna naléhavost.
   - **1 - Bez urgentnosti:** Nízká priorita.
   - AI musí tyto stupně automaticky přiřazovat na základě kontextu diktátu.

## Technické kroky (Aktualizováno)
- ✅ Refaktorace `App.tsx` pro implementaci Timeline v `week` view.
- ✅ Výpočet pozic pro úkoly na základě `startTime` (start 7:00) a `duration`.
- ✅ Implementace Time Indicatoru.
- ✅ Reorganizace layoutu: Přesun navigační lišty do hlavního headeru.
- ✅ Fixace scrollování: V týdenním režimu je scrollovatelný pouze kalendář, nikoliv celý layout.
- ✅ Redefinice urgentnosti na 3 stupně (1-3) + Update AI promptu.

## Cíl (Phase 3 - Mobile Sync & UI Optimization) ✅
Opravit a optimalizovat mobilní verzi tak, aby plně korespondovala s PC verzí a byla stoprocentně spolehlivá v synchronizaci.

1. **Robustní Synchronizace:** ✅
   - Synchronizace i globálního nastavení (Velikost písma, API klíče).
   - Oprava auto-restore: Pokud na mobilu chybí nastavení, aplikace si ho sama stáhne z Disku.
   - Indikátor stavu synchronizace přímo v mobilním UI.

2. **Mobilní UX Fokus:** ✅
   - Přizpůsobení "Focus Mode" pro mobil (skutečný fullscreen).
   - Vylepšení Timeline view na mobilu (přehlednost sloupců).
   - Prémiový vzhled mobilní navigace odpovídající PC aplikaci.

3. **Stabilizace dat:** ✅
   - Kontrola ukládání 3 stupňů urgentnosti.
   - Prevence přepsání novějších dat staršími při synchronizaci z více zařízení.
   - **Quick Access:** Tlačítko pro okamžitou zálohu v PC sidebaru.

## Technické kroky (Dokončeno)
- ✅ Přechod `uiScale` z localStorage do IndexDB (`db.settings`) pro sync.
- ✅ Refaktorace `checkSync` pro lepší detekci "prázdného" stavu na mobilu (timestamp-based auto-restore).
- ✅ Úprava UI `App.tsx` pro mobilní navigaci a Focus Mode (fullscreen).
- ✅ Přidání Sync statusu a manuálního tlačítka na mobilní obrazovku.
- ✅ Implementace Quick Backup tlačítka do PC Sidebar.
- ✅ Oprava řazení úkolů podle času a viditelnost "Pending" úkolů v Plánu.

## Cíl (Phase 4 - AI Audio Optimization & REST Stability) ✅
Optimalizace stávajícího audio workflow pro maximální rychlost s využitím nových Flash modelů. Cesta přes Gemini Live (WebSockets) byla opuštěna ve prospěch stabilního REST API.

1. **Efektivní nahrávání:** ✅
   - Implementace Silence Detection pro automatické ukončení nahrávání.
   - Audio a haptická zpětná vazba pro lepší UX (Pípnutí/Vibrace).

2. **Výběr modelů (Audio/REST):** ✅
   - Integrace 4 stabilních modelů:
     - `gemini-2.0-flash` (Default - rychlá odezva)
     - `gemini-1.5-flash` (Ekonomická varianta)
     - `gemini-2.5-flash` (Premium/Experimentální)
     - `gemini-1.5-pro` (Hluboká analýza)

## Technické kroky (Dokončeno)
- ✅ Implementace Silence Detection a Audio/Haptické odezvy.
- ✅ Stabilizace REST API s novým výběrem modelů.
- ✅ Odstranění nepotřebného `geminiLiveService.ts` a čistka v `useAudioRecorder.ts`.
- ✅ Odstranění WebSockets logiky z celé aplikace.
- ✅ Finalizace AI promptů pro bleskovou extrakci JSON.

## Cíl (Phase 5 - Advanced AI Intelligence & Relative Dates) ✅
Vylepšit schopnost AI pracovat s relativními časovými údaji pro přesnější plánování na základě aktuálního dne.

1. **Relativní termíny:** ✅
   - AI interpretuje "v pondělí", "příští úterý" atd. na základě dnešního data.
   - Pravidlo: Pokud je dnes pondělí a řekne "v pondělí", myslí se příští týden (+7).
   - Podpora pro "příští týden v [den]" (+7 k nadcházejícímu).
   
2. **Upgrade Modelu:** ✅
   - Přechod na `gemini-2.0-flash` jako výchozí model pro bleskové zpracování.

## Technické kroky (Dokončeno)
- ✅ Úprava `geminiService.ts`: Předávání názvu dne v týdnu do kontextu AI.
- ✅ Implementace robustní logiky termínů do systémového promptu (4 základní pravidla).
- ✅ Aktualizace JSON příkladu pro AI (přidání polí `date` a `deadline`).
- ✅ Nastavení `gemini-2.0-flash` jako default fallbacku v kódu.

## Cíl (Phase 6 - Visual Polish & Legibility) ✅
Dokončit vizuální ladění, sjednotit designové prvky a zajistit maximální čitelnost na všech zařízeních.

1. **Prémiové vizuály:** ✅
   - Sjednocení barevné palety (tmavé "Office" téma #0d1117).
   - Skleněné efekty (Glassmorphism) v navigaci.
   - **Barevné zvýraznění:** Tlačítka pro diktování mají výraznou cihlovou barvu pro snadnou orientaci.
   - Změna velikosti a chování mikrofonu na mobilu (automatické skrývání v editoru).

2. **Dynamické termíny:** ✅
   - Barevné kódování času do deadline (Zelená > 24h, Oranžová < 24h, Červená < 3h).
   - Integrace odpočtu do Focus Módu i týdenního přehledu.

3. **Čitelnost a UX:** ✅
   - Zvýšení kontrastu u šedých textů v tmavém režimu pro mobilní displeje.
   - Těsné propojení týdenního kalendáře (Sticky hlavičky, fixace mezer).
   - "Silent Refresh" pro Google Auth (konec neustálého odhlašování).

## Technické kroky (Dokončeno)
- ✅ Implementace `getDeadlineColor` a integrace do komponent.
- ✅ Refaktorace CSS pro zvýšení kontrastu textů (mobile-first overrides).
- ✅ Úprava `App.tsx`: Sticky hlavičky dnů a zarovnání časové osy na 7:00.
- ✅ Implementace Silent Refresh a Login Hint v `googleService.ts`.
- ✅ Barevná úprava mikrofonu (Brick color theme).

---
*Všechny cíle pro verzi 3.0.0 byly naplněny. Aplikace je připravena k ostrému nasazení.*
