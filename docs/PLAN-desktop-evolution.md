# PLAN: Desktop Evolution (Option A)

Plan pro transformaci aplikace na profesionální desktopové rozhraní "Premium Office".

## Kontext & Rozhodnutí
- **Sidebar:** Zůstává viditelný i během editace (kotva aplikace).
- **Kalendář:** 7-denní vertikální sloupce (Outlook style).
- **Vzhled:** Kompaktní, profesionální, tmavý/břidlicový design (Slate 950).
- **Sjednocení:** Úkoly (lokální i Google) se zobrazují v jednom seznamu.

---

## Fáze 1: UI Architektura & Desktop Layout
Cíl: Přizpůsobit základní strukturu pro maximální využití plochy PC.
- [ ] **Snížení density (Compact Mode):** Změna globálních CSS proměnných pro mezery (`gap`, `padding`). Snížení z mobilních hodnot na desktopové (např. 16px -> 8px u karet).
- [ ] **Sidebar Persistence:** Úprava layoutu tak, aby Sidebar nebyl overlay, ale pevná součást mřížky (Grid), která nezmizí při otevření detailu úkolu.
- [ ] **Desktop Nav:** Odstranění mobilní spodní lišty na širokých obrazovkách.

## Fáze 2: Sjednocený Systém Úkolů (Unified Logic)
Vysvětlení pro uživatele: Místo přepínání mezi "Úkoly" a "G-Úkoly" vytvoříme jeden chytrý seznam.
- [ ] **Refaktorace Hooku:** Vytvoření `useUnifiedTasks`, který spojí výsledky z Dexie DB a Google Tasks API.
- [ ] **Visual Identity:** Implementace ikon (`Lucide` icons) pro rozlišení zdroje (Lokální vs Google) přímo v seznamu.
- [ ] **Background Sync:** Automatické načítání Google Tasks při vstupu do aplikace bez nutnosti klikat na "G-Úkoly".

## Fáze 3: Desktop-First Kalendář (Vertical Columns)
- [ ] **Komponenta `DesktopWeekView`:** Implementace 7 sloupců vedle sebe.
- [ ] **Time-Grid:** Vertikální osa času pro schůzky (Meetingy).
- [ ] **Deadline Layer:** Úkoly, které mají deadline, se zobrazí v horní části příslušného dne jako "All-day" položky.
- [ ] **Navigace:** Tlačítka "Předchozí týden", "Dnes", "Další týden" v záhlaví kalendáře.

## Fáze 4: Focus Mode Editor (Maximalizace)
- [ ] **Expandable Editor:** Původní modální okno se změní na dynamický panel, který se roztáhne na celou zbývající šířku (vedle Sidebaru).
- [ ] **Maximalizace Textu:** Textové pole (description a notes) dostane prioritní prostor (70-80% šířky okna).
- [ ] **Barevné kódování:**
    - Meetingy: Sytěji modré/indigo akcenty.
    - Úkoly: Smaragdové / Jantarové dle priority.

## Fáze 5: Správa Dat (Management)
- [ ] **Manuální smazání:** Přidání ikony koše (Delete) do seznamu dokončených úkolů.
- [ ] **Bulk Actions:** Možnost označit více úkolů a smazat je najednou (volitelně).

---

## Verifikační Checklist
- [ ] Vidím 7 dní kalendáře vedle sebe na monitoru?
- [ ] Jsou Google Tasks vidět v hlavním seznamu úkolů?
- [ ] Zůstává Sidebar vidět i když edituji dlouhý text?
- [ ] Je design kompaktnější (méně prázdného místa mezi dlaždicemi)?
- [ ] Funguje manuální mazání dokončených úkolů?

## Rozdělení rolí
- **Orchestrator:** Celkový layout a integrace.
- **Frontend Specialist:** Design sloupkového kalendáře a Focus módu.
- **Backend/Service Specialist:** Sjednocení logiky načítání úkolů.
