# Uživatelská příručka: Bitevní Plán 🛡️

Vítejte v aplikaci **Bitevní Plán** – vašem profesionálním desktopovém centru pro správu času, úkolů a schůzek s využitím pokročilé umělé inteligence Gemini.

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

## 2. Přehled AI modelů a náklady 🧠

V nastavení si můžete zvolit mozek aplikace. Ceny jsou odvozeny z průměrného diktátu (cca 1000 vstupních a 200 výstupních tokenů*).

| Model | Charakteristika | Relativní kvalita | Cena (za 1M tokenů) | Odhad/měsíc** |
| :--- | :--- | :--- | :--- | :--- |
| **gemini-2.0-flash** | **Doporučeno.** Nejlepší poměr rychlost/inteligence. | ⭐⭐⭐⭐ | ~$0.10 in / $0.40 out | **~7 Kč** (0.27$) |
| **gemini-1.5-flash** | **Úsporný.** Extrémně levný, vhodný pro rychlé poznámky. | ⭐⭐⭐ | ~$0.075 in / $0.30 out | **~5 Kč** (0.20$) |
| **gemini-2.5-flash** | **Premium.** Vyšší přesnost a lepší pochopení kontextu. | ⭐⭐⭐⭐⭐ | ~$0.30 in / $2.50 out | **~30 Kč** (1.20$) |
| **gemini-1.5-pro** | **Analytik.** Pro velmi dlouhé zápisy a komplexní projekty. | ⭐⭐⭐⭐⭐ | ~$1.25 in / $5.00 out | **~85 Kč** (3.30$) |

*\* Přibližná cena za 1 milion tokenů (vstup/výstup). Pro většinu uživatelů platí bezplatný limit (Free Tier).*  
*\*\* Odhadovaná cena při intenzivním používání **50 diktátů denně po dobu 30 dnů**.*

---

## 3. Hlasové ovládání a AI Architekt 🎙️

Hlas je nejrychlejší cesta, jak dostat myšlenku do plánu.

### Jak nahrávat
- **Hlavní mikrofon (dole):** Vytvoří nový záznam (úkol, schůzku nebo myšlenku).
- **Mikrofon u úkolu:** Aktualizuje konkrétní úkol (např. "Změň čas na 14:00" nebo "Doplň poznámku").

### Inteligentní funkce
- **Detekce ticha:** Stačí mluvit. Jakmile se na pár sekund odmlčíte, aplikace nahrávání sama ukončí a odešle k analýze.
- **Zpětná vazba:** Start nahrávání je potvrzen krátkým pípnutím a vibrací (na podporovaných zařízeních).
- **Urgentnost (1-3):** AI automaticky rozpozná prioritu (3-Urgentní, 2-Normální, 1-Nízká).
- **Capacity Guardian (Strážce kapacity):** Pokud úkol vyžaduje více času, než kolik zbývá v pracovní době (7:00-19:00) do jeho termínu, začne v seznamu **červeně pulsovat**. To vás varuje, že termín není reálné stihnout bez přesčasů.
- **Deadline-First:** Pro úkoly (Tasks) je nejdůležitějším údajem **termín dokončení (deadline)**. V přehledu uvidíte ikonu přesýpacích hodin a přesný odpočet času, který vám do termínu zbývá.

---

## 4. Práce s aplikací (Workflow) 📋

### Sekce aplikace
- **Plán:** Váš strategický přehled pro dnešní den. Zobrazuje vše, co vyžaduje pozornost.
- **Týden:** Profesionální časová osa (7:00 – 19:00). Úkoly se v tomto pohledu zobrazují přesně v den svého **deadline**.
- **Úkoly / Schůzky / Myšlenky:** Filtrované seznamy pro hloubkovou práci.

### Focus Mode (Detailní editace)
Kliknutím na jakýkoliv úkol otevřete **Focus Mode**. Ten maximalizuje prostor pro psaní poznámek a umožňuje detailní nastavení:
- Změna typu (Úkol vs. Schůzka).
- **Nastavení termínu (Deadline):** Pokud zadáte pouze datum, systém automaticky nastaví čas na **15:00**.
- Správa **Checklistu** (podúkolů).

---

## 5. Synchronizace a zálohování ☁️

Vaše data jsou v bezpečí a dostupná všude.

- **Google Drive:** Aplikace automaticky zálohuje vaše data i nastavení na váš Google Disk. Při prvním spuštění na novém zařízení (nebo mobilu) se data automaticky obnoví.
- **Google Kalendář:** U schůzek (Meetingů) se v detailu úkolu objeví tlačítko **Odeslat do Kalendáře**.
- **Google Tasks:** Úkoly jsou obousměrně synchronizovány. Co splníte v Bitevním Plánu, odškrtne se i v Google Tasks a naopak.

---

## 6. Tipy pro efektivitu 💡

1. **Diktujte detaily:** "Schůzka s Petrem zítra v 10 v Mánesu, téma je nová smlouva." – AI se postará o zbytek.
2. **Škálování:** Pokud je na vás písmo příliš malé, použijte jezdec **Velikost písma** v nastavení.
3. **Diagnostika:** Pokud něco nefunguje, sekce **Diagnostika** v sidebaru vám ukáže technické logy a stav připojení k AI.

---
*Vytvořeno pro verzi 1.0 – Bitevní Plán: Vždy o krok napřed.*
