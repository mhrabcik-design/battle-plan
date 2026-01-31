# 🚀 Budoucí rozvoj: Bitevní Plán (Next Sessions)

Tento dokument slouží jako strategický zásobník nápadů pro další fáze vývoje. Zaměřuje se na prohloubení inteligence systému a jeho těsnější integraci do pracovního workflow.

---

## 🔍 1. Inteligentní hlasové vyhledávání a dotazování

Místo prostého vyhledávání klíčových slov budeme směřovat k **sémantickému vyhledávání**, kde AI rozumí kontextu tvého dotazu.

### Charakteristika:
- **Hlasový dotaz:** Speciální režim "Dotaz" (aktivovatelný např. dlouhým podržením mikrofonu nebo klávesovou zkratkou).
- **Kontextová paměť:** AI prohledá nejen názvy, ale i bohaté popisy, podúkoly a myšlenky.
- **Příklady dotazů:**
  - „Co všechno musím udělat pro projekt Rekonstrukce?“
  - „Kdy mám příští týden čas na schůzku s designéry?“
  - „Mám v plánu nějaké úkoly, které souvisí s rozpočtem?“
  - „Jaké byly hlavní body z minulé schůzky s Petrem?“

### Technická realizace:
- **RAG (Retrieval-Augmented Generation) Lite:** Pro efektivní vyhledávání v lokální IndexedDB (Dexie) budeme AI v dotazu posílat relevantní úryvky dat.
- **Dynamic Filtering:** AI místo vytvoření úkolu vrátí instrukci pro UI, které okamžitě vyfiltruje seznam záznamů nebo zobrazí textovou odpověď (shrnutí).

---

## 📅 2. Propojení s Kalendářem 2.0 & Detekce kolizí

Cílem je udělat z Bitevního Plánu aktivního hlídače tvého času, nejen pasivní záznamník.

### Charakteristika:
- **Obousměrný náhled:** Při diktování nové schůzky se systém automaticky podívá do tvého reálného Google Kalendáře.
- **Hlášení kolizí:** Pokud se snažíš naplánovat schůzku na čas, kdy už něco máš, AI tě na to upozorní ještě před uložením.
  - *Příklad:* „Chceš schůzku na 14:00, ale v kalendáři už máš 'Prezentace výsledků'. Mám to zapsat i tak, nebo zkusíme jiný čas?“
- **Návrh volných slotů:** Pokud řekneš „Naplánuj schůzku na zítra odpoledne“, AI projde kalendář a navrhne: „Zítra máš volno mezi 13:00 a 15:30. Nastavil jsem to na 13:00.“

### Technická realizace:
- **G-Cal Read Access:** Rozšíření práv Google Auth o čtení událostí (Calendar.events.list).
- **Collision Detection Logic:** Funkce v `App.tsx`, která porovná `startTime` a `duration` nového záznamu s existujícími událostmi v Google Kalendáři.
- **UI Feedback:** Vizuální varování (např. oranžový vykřičník) v Focus Módu u pole pro čas, pokud existuje překryv.

---

## 🛠️ Další drobné náměty:
- **Bulk Operations:** Možnost označit více úkolů a hromadně jim změnit termín nebo prioritu pomocí hlasu („Všechny dnešní úkoly odsuň na zítra“).
- **Widget do systému:** Malá "plovoucí" ikona mikrofonu, která zůstane nad všemi okny pro okamžitý diktát bez přepínání do prohlížeče.

---
*Bitevní Plán – Strategická převaha začíná plánem.*
