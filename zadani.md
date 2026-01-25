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


