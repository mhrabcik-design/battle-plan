# Projekt: Bitevní Plán - Desktop Transformation & Sync

## Stav
✅ Zvětšení pracovní plochy dokončeno.
✅ Adaptivní grid (1-4 sloupce) aktivní.
✅ AI Indikátor (Klíč + Online) implementován.
✅ Škálování UI (Font Slider) funkční.
✅ Multipart Google Drive Sync opraven (mobil i PC).

## Cíl
Transformovat aplikaci z "mobilu v prohlížeči" na profesionální **Desktop-First aplikaci** s hlubokou integrací do Google ekosystému.

## Požadavky (Aktualizováno - Desktop Evolution Option A)

1. **Sjednocení úkolů (Task Merging):**
   - Zrušit rozdělení na "Úkoly" a "G-Úkoly".
   - V sidebaru bude pouze jedna kategorie "Úkoly".
   - Systém se bude chovat jako sjednocený seznam, kde jsou lokální úkoly i Google Tasks na jednom místě (odlišené např. ikonou).
   - Sync s Google Tasks probíhá na pozadí.

2. **Desktop-First Kalendář (Vertical Columns):**
   - Nahradit dlaždicové zobrazení týdne vertikálními sloupci (jako Outlook/Linear).
   - Sloupce představují dny (např. 7 dní vedle sebe).
   - V kalendáři se zobrazují Schůzky (Meetingy) i Deadliny úkolů.
   - **Barevné rozlišení:** Jasně odlišit Meetingy (např. sytě modrá/fialová) od Úkolů (např. smaragdová/oranžová).

3. **Maximalizovaná Editace (Focus Mode):**
   - Při rozkliknutí úkolu nebo meetingu se otevře editační okno dynamicky přes celou obrazovku (Focus Mode).
   - Cílem je maximalizovat prostor pro psaní a editaci textu (text-area přes většinu šířky).
   - Odstranit zbytečné okraje a "mobilní" mezery.

4. **Desktop Layout & Mezery:**
   - Celkový vzhled musí působit jako nativní profesionální PC aplikace (Desktop-First).
   - Minimalizovat mezery (paddingy/gaps) mezi panely pro maximální využití pracovní plochy.
   - Barevné schéma a náhled PC verze se může lišit od mobilní (více "office/professional" look).

## Technické kroky (Aktualizováno)
- Refaktorace `App.tsx` pro odstranění `google-tasks` view a integraci do hlavního seznamu.
- Vytvoření nové komponenty `DesktopWeekView` s vertikálními sloupci.
- Úprava `EditTaskModal` (nebo nový `TaskEditor`) pro full-screen zobrazení.
- Globální úprava CSS pro snížení "vzdušnosti" (compact mode).

