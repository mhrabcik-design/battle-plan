# PLAN: Uživatelská dokumentace (navod.md)

Vytvoření komplexního, strukturovaného návodu v češtině, který pokryje nastavení i veškeré funkce aplikace Bitevní Plán.

## Cíl
Vytvořit soubor `navod.md` v kořenovém adresáři, který bude sloužit jako hlavní příručka pro uživatele.

## Kontext
- Aplikace: Bitevní Plán (Desktop-First).
- Technologie: React, IndexDB, Gemini REST API, Google Drive/Tasks API.
- Klíčové vlastnosti: Hlasové ovládání, časová osa 7-19h, Focus Mode, Cloud Sync.

## Přehled úkolů

- [x] **Task 1: Průzkum a struktura**
    - Projít `App.tsx` a `zadani.md` pro zachycení všech aktuálních funkcí (včetně změn z Audio Pivot).
    - Definovat osnovu souboru `navod.md`.
    - **Verify:** Seznam funkcí je kompletní.

- [x] **Task 2: Sekce Nastavení (Setup) a Přehled modelů**
    - Popis získání a vložení Gemini API klíče.
    - Postup pro přihlášení ke Google účtu.
    - Nastavení velikosti písma.
    - **Detailní srovnání modelů:** 
        - Vytvořit tabulku se 4 modely.
        - Uvést přibližné ceny (založené na aktuálních Gemini API sazbách).
        - Přidat stručný popis předností (např. 2.0 Flash pro rychlost vs. 1.5 Pro pro složité úkoly).
    - **Verify:** Sekce "Nastavení" a "Srovnání modelů" s cenami je v `navod.md`.

- [x] **Task 3: Sekce Hlasové ovládání (AI)**
    - Jak funguje nahrávání (hlavní tlačítko vs. u úkolu).
    - Detekce ticha a automatické odesílání.
    - Formáty diktování (Urgentnost 1-3, struktura schůzek).
    - **Verify:** Sekce "Hlasové ovládání" je v `navod.md`.

- [x] **Task 4: Sekce Zobrazení a Workflow**
    - Plán (Dnešní přehled).
    - Týdenní časová osa (7:00 - 19:00, barevné rozlišení).
    - Focus Mode (Detailní editace přes celou plochu).
    - **Verify:** Sekce "Funkce a Zobrazení" je v `navod.md`.

- [x] **Task 5: Sekce Synchronizace**
    - Automatické zálohování na Google Drive.
    - Propojení s Google Tasks (sjednocený seznam).
    - Odesílání schůzek do Google Kalendáře.
    - **Verify:** Sekce "Synchronizace a Záloha" je v `navod.md`.

- [x] **Phase X: Korektura a Formátování**
    - Kontrola češtiny, tónu (profesionální/přehledný) a Markdown formátování (tabulky, seznamy).
    - **Verify:** Soubor `navod.md` je finálně revidován.

## Agent Assignments
- **Project Planner:** Příprava struktury a dohled nad úplností.
- **Documentation Writer:** Psaní samotného obsahu v `navod.md`.

## Akceptační kritéria
- Soubor `navod.md` existuje v kořenovém adresáři.
- Dokumentace je kompletně v češtině.
- Obsahuje jasný návod "krok za krokem" pro prvotní nastavení.
- **Obsahuje přehlednou tabulku modelů s popisem kvality a orientační cenou.**
- Popisuje rozdíly mezi urgentnostmi 1, 2 a 3.
- Popisuje fungování synchronizace.
