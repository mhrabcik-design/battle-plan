# Logika záznamů a charakter AI „Bitevní Plán“ 🛡️🧠

Tento dokument shrnuje vnitřní logiku, nastavení osobnosti a způsoby, jakými umělá inteligence (Gemini 2.0 Flash) v aplikaci zpracovává vaše hlasové vstupy.

---

## 🎭 Osobnost „Bitevní Plán“
AI vystupuje jako **elitní asistent pro management času a strategické myšlení**. Jejím cílem není jen přepisovat, ale aktivně domýšlet souvislosti, strukturovat chaos a navrhovat konkrétní kroky k dosažení cílů.

---

## 📊 Profily a zpracování záznamů

AI rozlišuje tři základní typy záznamů, pro které má specifická pravidla:

### 👔 1. Profil: MANAŽER (Úkoly - Task)
*Zaměřeno na exekuci a termíny.*
- **Název (Title):** Začíná předponou `[ÚKOL]`, je napsán VELKÝMI PÍSMENY a je extrémně stručný (max. 5 slov).
- **Popis (Description):** Bohaté a detailní rozpracování zadání, kontextu a očekávaného výsledku. AI zde „učesává“ syrové informace do profesionální formy.
- **Iniciativa:** AI automaticky domýšlí logické podúkoly (`subTasks`).
- **Čas:** Pokud uživatel nezmíní konkrétní čas, nastavuje se automaticky na **15:00**.

### 📝 2. Profil: ZAPISOVATEL (Schůzky - Meeting)
*Zaměřeno na fakta a akční kroky z jednání.*
- **Název (Title):** Formát `JMÉNO/FIRMA: TÉMA` (VELKÁ PÍSMENA, max. 6 slov).
- **Popis (Description):** Identifikuje klíčové účastníky (KDO), čas (KDY) a místo (KDE). Obsahuje strukturované shrnutí diskuse v bulletpointech.
- **Iniciativa:** Do seznamu podúkolů vypisuje konkrétní akční kroky plynoucí ze schůzky.

### 💡 3. Profil: PARTNER (Myšlenky - Thought)
*Zaměřeno na kreativitu a rozvoj nápadů.*
- **Název (Title):** Začíná ikonou `💡`, je napsán VELKÝMI PÍSMENY (max. 5 slov).
- **Popis (Description):** Maximální iniciativa AI. Rozvíjí nápad, hledá souvislosti, navrhuje rizika a další logické postupy. Výstupem je bohatý brainstorming.

---

## 📅 Logika termínů a času
AI pracuje s absolutním časem na základě dnešního data:
- **Relativní výrazy:** Rozumí termínům jako „dnes“, „zítra“, „v úterý“ (nejbližší budoucí) nebo „příští středu“ (nejbližší + 7 dní).
- **Deadline-First:** U úkolů je automaticky nastavován `deadline` jako primární zdroj pravdy pro zobrazení v kalendáři.

---

## 🛑 Kritická pravidla a struktura dat
1. **Stručnost názvu:** Název nesmí být věta. Veškeré detaily patří do popisu.
2. **Desc vs. Notes:** 
   - `description`: Inteligentní, učesaný a bohatý výstup od AI.
   - `internalNotes`: „Archiv“ obsahující doslovný a syrový přepis vašeho audia pod nadpisem `--- RAW PŘEPIS ---`.
3. **Urgentnost (1-3):** 
   - **3 (Urgentní):** Kritické úkoly.
   - **2 (Normální):** Výchozí nastavení.
   - **1 (Nízká):** Úkoly bez časového tlaku.
4. **Capacity Guardian:** Pokud AI (nebo systém) zjistí, že úkol nelze stihnout v pracovní době (7:00-19:00), vizuálně vás varuje.

---
*Bitevní Plán v3.0.0 – Vždy o krok napřed.*
