# PROJEKTOVÝ STATUS: Bitevní Plán (Audio AI PWA)

Zpráva o stavu k: **21. 1. 2026, 00:08**
Celkový progres projektu: **~70% (Core MVP Dokončeno, Sync Fáze čekají)**

---

## 1. STRATEGICKÝ PŘEHLED (ROADMAP)
| Fáze | Modul | Stav | Popis |
|-------|------|-------|-------|
| **1** | **Základní Motor** | ✅ 100% | Audio záznam, Dexie DB, Tailwind v4. |
| **2** | **AI Integrace** | ✅ 100% | Gemini analýza, sub-tasky, interní notes. |
| **3** | **Bitevní Plán** | ✅ 100% | Lineární seznam, Týdenní přehled, Export. |
| **4** | **Google Calendar** | ⏳ 0% | **PLÁNOVÁNO:** OAuth2, odesílání schůzek do kalendáře. |
| **5** | **Cloud Sync** | ⏳ 0% | **PLÁNOVÁNO:** Google Drive API, přístup z PC, synchronizace. |
| **X** | **Polish & PWA** | 🔄 40% | Zvuky, notifikace, instalace na plochu. |

---

## 2. DETAILNÍ STAV IMPLEMENTACE

### ✅ Hotovo (Fáze 1 - 3)
- [x] Hlasová analýza Gemini (včetně detailních zápisů).
- [x] Inteligentní Týdenní přehled (jen aktivní věci).
- [x] Export do Gmailu (naformátovaný text).
- [x] Sub-task logic & Progress sync.

### 🚀 Nadcházející: Fáze 4 - Google Calendar
- [ ] Implementace OAuth2 (přihlášení Google účtem).
- [ ] Funkce "Odeslat do kalendáře" u schůzek.
- [ ] Obousměrná kontrola (vidět kalendář v Bitevním plánu).

### ☁️ Nadcházející: Fáze 5 - Cloud Sync
- [ ] Integrace Google Drive API (ukládání DB do cloudu).
- [ ] Detekce konfliktů při syncu mezi mobilem a PC.
- [ ] Optimalizace UI pro široké monitory (PC View).

---

## 3. KRITICKÉ POZNÁMKY (Z ARCHITEKTURY)
- **Bezpečnost:** Pro integraci Google API bude nutné přejít z `localhost` na HTTPS (např. přes `ngrok` nebo produkční doménu).
- **Offline:** Cloud sync musí být navržen jako "offline-first" – data jsou primárně v Dexie a na pozadí se syncují.

---

## ✅ AKTUÁLNÍ DOPORUČENÍ
Nyní, když máme vyladěné lokální fungování a exporty, je ideální čas postoupit k **Fázi 4 (Google Calendar)**, abychom propojili schůzky s vaším reálným kalendářem.
