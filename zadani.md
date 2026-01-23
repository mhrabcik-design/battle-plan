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
   - **Header Layout:** Lišta s měsícem a navigací (Dnes, <, >) přesunuta nahoru mezi nadpis "TÝDEN" a samotné sloupce.
   - **Vertikální Časová Osa:** Přidat nalevo časovou osu od 06:00 do 20:00.
   - **Dynamické Sloupce:** Sloupce dnů se roztahují dynamicky až dolů na konec stránky.
   - **Pozicování dle Času:** Schůzky a úkoly s časem se zobrazují na příslušném místě v časové ose (absolutní pozicování nebo grid-based).
   - **Indikátor Aktuálního Času:** Linka ukazující aktuální čas v rámci časové osy.
   - **Vizuální Styl:** Zachovat profesionální "office" look s minimalizovanými mezerami.

3. **Maximalizovaná Editace (Focus Mode):**
   - Při rozkliknutí úkolu nebo meetingu se otevře editační okno dynamicky přes celou obrazovku (Focus Mode).
   - Cílem je maximalizovat prostor pro psaní a editaci textu (text-area přes většinu šířky).
   - Odstranit zbytečné okraje a "mobilní" mezery.

4. **Desktop Layout & Mezery:**
   - Celkový vzhled musí působit jako nativní profesionální PC aplikace (Desktop-First).
   - Minimalizovat mezery (paddingy/gaps) mezi panely pro maximální využití pracovní plochy.
   - Barevné schéma a náhled PC verze se může lišit od mobilní (více "office/professional" look).

## Technické kroky (Aktualizováno)
- Refaktorace `App.tsx` pro implementaci Timeline v `week` view.
- Výpočet pozic pro úkoly na základě `startTime` a `duration`.
- Implementace Time Indicatoru.
- Reorganizace layoutu `week` view pro přesun navigační lišty.
- Úprava CSS pro dynamic height a grid alignment.


