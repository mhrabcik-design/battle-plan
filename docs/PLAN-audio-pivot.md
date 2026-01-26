# PLAN: Audio Pivot & Code Cleanup

Pivot z "Gemini Live" (WebSockets) zpět na stabilní REST API s využitím 4 vybraných modelů.

## Kontext
Model `gemini-2.5-flash-native-audio-dialog` není aktuálně dostupný v API. Rozhodli jsme se opustit cestu streamování přes WebSockets a plně se soustředit na optimalizované REST volání, které je díky modelům `flash` dostatečně rychlé a stabilní.

---

## Fáze 1: Úklid kódu (Cleanup)
- [x] Odstranit soubor `src/services/geminiLiveService.ts`.
- [x] Odstranit import `geminiLiveService` v `App.tsx`.
- [x] Vyčistit nepoužívané proměnné nebo logiku spojenou s "Live Mode" (pokud nějaká zbyla po předchozích úpravách).

## Fáze 2: Konfigurace Modelů
- [x] Aktualizovat pole `availableModels` v `App.tsx` na:
    1. `gemini-2.0-flash` (Default)
    2. `gemini-1.5-flash`
    3. `gemini-2.5-flash` (Premium)
    4. `gemini-1.5-pro` (Analýza)
- [x] Ověřit, že defaultní model při startu aplikace je `gemini-2.0-flash`.

## Fáze 3: Aktualizace Zadání
- [x] Upravit `zadani.md`:
    - Přesunout "Gemini Live" (Phase 4) do archivu/zrušených úkolů.
    - Definovat novou Phase 4 zaměřenou na "AI Logic Refinement" (pokud bude potřeba) nebo prohlásit audio část za hotovou ve verzi 1.0.

## Fáze 4: Ověření (Verification)
- [x] Manuální test: Nahrát audio -> Počkat na pípnutí (Stop) -> Ověřit, že `geminiService.ts` (REST) správně zpracuje požadavek.
- [x] Ověřit, že detekce ticha stále spouští zpracování přes REST API.

---

## Agent Assignments
- **Orchestrator/App Builder:** Provedení čistky kódu a aktualizace modelů v `App.tsx`.
- **Project Planner:** Aktualizace dokumentace a `zadani.md`.

## Akceptační kritéria
- Kód neobsahuje žádné reference na `geminiLiveService`.
- Dropdown v nastavení nabízí přesně 4 modely dle plánu.
- Nahrávání funguje stabilně se zvukovou/haptickou odezvou.
