# Logika záznamů a charakter AI „Bitevní Plán“ 🛡️🧠

Tento dokument shrnuje vnitřní logiku, nastavení osobnosti a způsoby, jakými umělá inteligence (Gemini 2.0 Flash) v aplikaci zpracovává vaše hlasové vstupy. Celý systém je striktně nastaven na **evropské standardy (24hodinový formát)**.

---

## 🕒 Evropský časový systém (24h)
Všechny časové údaje v aplikaci i při komunikaci s AI používají výhradně 24hodinový formát.
- **Odpolední časy:** 1:00 PM = **13:00**, 5:30 PM = **17:30** atd.
- **Půlnoc:** 00:00.
- **Dopoledne:** 00:00 - 12:00.
- AI v promptu dostává instrukci, že jakýkoliv čas zmíněný slovy (např. „v jednu odpoledne“) musí okamžitě převést na 24h ekvivalent.

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

## 📅 Logika termínů a času (Date vs. Deadline)
Od verze 4.0.0 se striktně rozlišuje mezi `date` (Datum konání / začátek akce) a `deadline` (Nejzazší termín dokončení):
- **Úkoly (Task):** Primárně pracují s `deadline`. Kdy se na nich začne pracovat je volitelné.
- **Schůzky (Meeting):** Primárně pracují s `date`. Schůzka má konkrétní datum a čas konání.
- **Relativní výrazy:** Rozumí termínům jako „dnes“, „zítra“, „v úterý“ (nejbližší budoucí) nebo „příští středu“ (nejbližší + 7 dní).
- Pokud uživatel nadiktuje „Do zítřka musím...“, AI nastaví `deadline` na zítřek. Pokud řekne „Zítra mám meeting...“, AI nastaví `date` na zítřek.

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
4. **Preservace dat při aktualizaci a Sync:** 
   - AI při hlasové změně (např. „posuň to na 12:00“) nesmí smazat původní bohatý popis. Změny se slučují.
   - Lokální změny z UI a změny od AI se slučují na základě atributu `updatedAt`. Pokud dojde v offline režimu na jiném zařízení k úpravě, novější `updatedAt` vítězí.
5. **Soft Delete:** Smazané úkoly nejsou ihned nevratně odstraněny (kvůli prevenci ztráty dat při synchronizaci). Jsou označeny symbolem `isDeleted` a fyzicky odstaněny až po potvrzené synchronizaci na Disk/Cloud.

---
*Bitevní Plán v4.0.0 – Vždy o krok napřed.*
