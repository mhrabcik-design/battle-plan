# PLAN: AI Intelligence Manifest & Brainstorming Partner

## 🎯 Cíl
Transformovat AI z prostého zapisovatele na inteligentního partnera s různou úrovní iniciativy podle typu záznamu, při zachování 100% bezpečnosti původních dat.

## 📋 Kontext
Aktuálně aplikace používá jeden univerzální prompt. Uživatel vyžaduje, aby u "Myšlenek" byla AI vysoce iniciativní (brainstorming, rozvíjení nápadů), zatímco u "Úkolů" a "Schůzek" udržovala strukturu a disciplínu.

---

## 🏗️ Fáze 1: Definice Manifestu (Příprava)
Vytvoření souboru `docs/AI_MANIFEST.md`, který bude obsahovat:
- **Profil ÚKOL (Manager):** Fokus na termíny, sub-tasky a prioritu.
- **Profil SCHŮZKA (Recorder):** Fokus na účastníky, čas, lokaci, klíčové body a akční kroky. 
- **Profil MYŠLENKA (Partner):** Fokus na kreativitu, hledání souvislostí a elaboraci nápadů.
- **Standard výstupu:** Specifikace, že `internalNotes` vždy obsahuje RAW přepis pro možnost návratu.

## 🛠️ Fáze 2: Refaktoring GeminiService
- **Verzování promptů:** Zavedení struktury pro snadné přepínání mezi "Classic" a "Manifest" režimem.
- **Kontextové větvení:** Úprava `processAudio` aby (pokud je to možné) detekovala záměr a vybrala správný sub-prompt.
- **Retry Logic Integration:** Zachování stávajícího retry mechanismu pro 429 chyby.

## 🧪 Fáze 3: Validace a Testování
- **Test A (Úkol):** "Zítra musím připravit prezentaci pro klienta, zabere to 3 hodiny." -> Očekáváme sub-tasky (např. rešerše, design, revize).
- **Test B (Myšlenka):** "Napadlo mě, že bychom mohli prodávat kafe v balíčcích s předplatným." -> Očekáváme rozvedení o logistiku, marketingové nápady a bulletpointy.
- **Test C (Zpětná kompatibilita):** Ověření, že změna nerozbila stávající funkce.

## 🏁 Akceptační kritéria
- [x] Existuje soubor `docs/AI_MANIFEST.md`.
- [x] AI u myšlenek aktivně navrhuje rozšíření a souvislosti.
- [x] Původní diktát je vždy dohledatelný v `internalNotes`.
- [x] AI zvládá relativní termíny (v pondělí, příští týden). ✅
- [ ] Lze se snadno vrátit k původnímu chování (Classic mode) změnou jedné konstanty v kódu.
