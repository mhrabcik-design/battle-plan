# Uživatelská příručka: Bitevní Plán 🛡️

Vítejte v aplikaci **Bitevní Plán** – vašem profesionálním desktopovém centru pro správu času, úkolů a schůzek s využitím pokročilé umělé inteligence Gemini. Vše v aplikaci se řídí **evropskými standardy (24hodinový časový systém)**.

---

## 1. Rychlý start: Prvotní nastavení ⚙️

Aby aplikace fungovala naplno, je potřeba provést dva základní kroky v sekci **Konfigurace** (levý panel):

### A. Aktivace AI (Gemini API)
Aplikace využívá modely Google Gemini pro zpracování hlasu.
1. Získejte svůj bezplatný nebo placený API klíč na [Google AI Studio](https://aistudio.google.com/).
2. Vložte klíč do pole **Gemini API klíč** v nastavení aplikace.
3. Klikněte na **Uložit nastavení**.

### B. Propojení s Google účtem
Pro zálohování dat a synchronizaci s kalendářem:
1. Klikněte na tlačítko **Google Přihlášení**.
2. Po přihlášení se aktivují funkce **Zálohovat na Disk** a **Synchronizace úkolů**.

---

## 2. Přehled AI modelů 🧠

V nastavení si můžete zvolit mozek aplikace. Aktuální seznam vychází z registru modelů v `battle-plan/src/services/geminiService.ts`.

| Model | Charakteristika | Doporučené použití |
| :--- | :--- | :--- |
| **gemini-3-flash-preview** | **Výchozí model.** Nejnovější rychlý model v aplikaci. | Denní diktování a běžné aktualizace záznamů. |
| **gemini-2.5-flash** | Rychlý a kvalitní model pro širší úlohy. | Běžná práce, když preview model není vhodný. |
| **gemini-2.5-flash-lite** | Lehčí varianta pro úspornější zpracování. | Jednoduché diktáty a rychlé poznámky. |
| **gemini-2.5-pro** | Nejsilnější volba v seznamu. | Dlouhé, komplexní nebo nejednoznačné vstupy. |

Ceníky a dostupnost modelů se mohou měnit podle Google AI účtu a regionu. Pokud řešíte náklady, berte jako závazný zdroj aktuální ceník Google AI Studio.

---

## 3. Hlasové ovládání a AI Architekt 🎙️

Hlas je nejrychlejší cesta, jak dostat myšlenku do plánu.

### Jak nahrávat
- **Hlavní mikrofon (dole):** Vytvoří nový záznam (úkol, schůzku nebo myšlenku).
- **Mikrofon u úkolu:** Aktualizuje konkrétní úkol (např. "Změň čas na 14:00" nebo "Doplň poznámku").
- **Diktování v záložce Práce:** Vytvoří jednu nebo více pracovních činností s projektem, lidmi, člověkohodinami, datem a popisem. Před uložením se zobrazí potvrzovací okno.

### Inteligentní funkce
- **Detekce ticha:** Stačí mluvit. Jakmile se na pár sekund odmlčíte, aplikace nahrávání sama ukončí a odešle k analýze.
- **Zpětná vazba:** Start nahrávání je potvrzen krátkým pípnutím a vibrací. **Diktovací tlačítka mají cihlovou barvu** pro okamžitou rozpoznatelnost.
- **Urgentnost (1-3):** AI automaticky rozpozná prioritu (3-Urgentní, 2-Normální, 1-Nízká).
- **Capacity Guardian (Strážce kapacity):** Pokud úkol vyžaduje více času, než kolik zbývá v pracovní době (7:00-19:00) do jeho termínu, začne v seznamu **červeně pulsovat**.
- **Inteligentní Deadline:** U úkolů uvidíte ikonu přesýpacích hodin s barevným odpočtem:
  - 🟢 **Zelená:** Zbývá více než 24 hodin.
  - 🟡 **Oranžová:** Termín je dnes (méně než 24 hod).
  - 🔴 **Červená:** Kritický čas (méně než 3 hodiny nebo po termínu).

---

## 4. Práce s aplikací (Workflow) 📋

### Sekce aplikace
- **Plán:** Váš strategický přehled pro dnešní den. Zobrazuje vše, co vyžaduje pozornost.
- **Týden:** Profesionální časová osa (7:00 – 19:00). Úkoly se v tomto pohledu zobrazují přesně v den svého **deadline**.
- **Úkoly / Schůzky / Myšlenky:** Filtrované seznamy pro hloubkovou práci.
- **Práce:** Evidence reálně odpracovaných činností. Každý záznam má projekt, lidi, reportované hodiny, datum a popis. Zobrazení lze přepnout mezi kartami, kalendářem a tabulkou.
- **Návrhy:** Schvalování návrhů od Anu před jejich zápisem do plánu.

### Práce (Pracovní činnosti)
Záložka **Práce** slouží pro večerní evidenci toho, co se skutečně dělalo.
- **Přidat činnost:** Ruční formulář pro projekt, datum, lidi, hodiny a popis.
- **Diktovat:** Hlasový vstup vytáhne pracovní činnost přes Gemini a otevře potvrzení před uložením. Delší diktát typu „minulý týden každý den 3 lidi po 10 hodinách“ se rozpadne na více denních návrhů.
- **Člověkohodiny:** U batch diktování se součet počítá jako počet lidí × hodiny na osobu, např. 3 lidé × 10 h = 30 h.
- **Projekty:** Projekt je povinný kvůli pozdějšímu přehledu a synchronizaci.
- **Filtrování schůzek:** Pokud záznam vypadá jako schůzka nebo jednání, nezapočítá se do sumy práce a UI ukáže, kolik záznamů bylo skryto.

### Focus Mode (Detailní editace)
Kliknutím na jakýkoliv úkol otevřete **Focus Mode**. Ten maximalizuje prostor pro psaní poznámek a umožňuje detailní nastavení:
- Změna typu (Úkol vs. Schůzka).
- **Nastavení času (24h):** Pole pro čas je nyní **vlastní textový vstup**, který ignoruje nastavení systému (žádné AM/PM). Stačí napsat např. `1300` a systém automaticky doplní dvojtečku na `13:00`.
- Správa **Checklistu** (podúkolů).

---

## 5. Synchronizace a zálohování ☁️

Vaše data jsou v bezpečí a dostupná všude.

- **Google Drive:** Aplikace automaticky zálohuje vaše data i nastavení na váš Google Disk. **Přihlášení je nyní stabilní** – aplikace si obnovuje přístup na pozadí, abyste se nemuseli každou hodinu znovu přihlašovat.
- **Google Kalendář:** U schůzek (Meetingů) se v detailu úkolu objeví tlačítko **Odeslat do Kalendáře**.
- **Google Tasks:** Úkoly jsou obousměrně synchronizovány. Co splníte v Bitevním Plánu, odškrtne se i v Google Tasks a naopak.
- **Pracovní činnosti:** Projekty a worklogy se synchronizují samostatně přes `work_logs_data.json` ve složce `/Anu-BattlePlan/`.

---

## 6. Tipy pro efektivitu 💡

1. **Diktujte detaily:** "Schůzka s Petrem zítra v 10 v Mánesu, téma je nová smlouva." – AI se postará o zbytek.
2. **Škálování:** Pokud je na vás písmo příliš malé, použijte jezdec **Velikost písma** v nastavení.
3. **Diagnostika:** Pokud něco nefunguje, sekce **Diagnostika** v sidebaru vám ukáže technické logy a stav připojení k AI.

---
*Aktualizováno pro verzi 4.2.1 – Bitevní Plán: Vždy o krok napřed.*
