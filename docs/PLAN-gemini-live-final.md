# PLAN: Finální test Gemini Live API (Unlimited)

## Cíl
Systematicky vyčerpat všechny možnosti zprovoznění Google Gemini Live API s neomezenými limity. Pokud selže, přejít na Abacus.ai.

---

## Fáze 1: Diagnostika současného stavu

### 1.1 Shrnutí problému
- **Model v UI:** `gemini-2.5-flash-native-audio-dialog`
- **Skutečný limit:** Unlimited (viz screenshot)
- **Chyba:** WebSocket 1006 (Abnormal Closure)
- **Příčina:** Model ID není platné API ID

### 1.2 Zjištěná fakta
| Fakt | Zdroj |
|------|-------|
| `gemini-2.5-flash-native-audio-dialog` je Live API model | Google AI Studio |
| Má Unlimited RPM/RPD | Screenshot |
| Není to platné API model ID | REST API chybová hláška |
| `gemini-2.0-flash-exp` je doporučený Live model | Dokumentace |

---

## Fáze 2: Systematické testování

### Test 1: Ověření správného Model ID
- [x] Změnit interní mapování na `gemini-2.0-flash-exp`
- [ ] Nasadit a otestovat
- [ ] Zkontrolovat log: "Připojování k Gemini Live: models/gemini-2.0-flash-exp"

### Test 2: Alternativní Model ID
Pokud Test 1 selže, zkusit tyto alternativy:
- [ ] `gemini-2.0-flash` (bez -exp)
- [ ] `gemini-live-2.0-flash`
- [ ] `gemini-2.0-flash-live-001`

### Test 3: Endpoint verze
- [ ] `v1beta` (současný)
- [ ] `v1alpha` (experimentální)
- [ ] `v2beta` (nová verze?)

### Test 4: Minimální handshake
- [ ] Setup pouze s `model`, bez `generation_config`
- [ ] Přidat `generation_config` až po `setupComplete`

### Test 5: Browser/Network diagnostika
- [ ] Otestovat v Chrome DevTools (Network tab - WS)
- [ ] Zkusit bez VPN/firewallu
- [ ] Otestovat na jiném zařízení

---

## Fáze 3: Rozhodovací bod

### Kritéria úspěchu
✅ WebSocket se připojí (log: "WebSocket otevřen")
✅ Server potvrdí setup (log: "Setup potvrzen serverem")
✅ Audio se odesílá bez chyb
✅ JSON odpověď se vrátí

### Kritéria pro přechod na Abacus
❌ Všechny testy selhaly
❌ Chyba přetrvává i na jiném zařízení
❌ Google dokumentace neuvádí řešení

---

## Fáze 4: Implementace (pokud Live API funguje)

### Úkoly
1. Aktualizovat UI - přejmenovat model na "Gemini Live (Unlimited)"
2. Vyčistit fallback logiku
3. Přidat lepší error handling pro edge cases
4. Zdokumentovat funkční konfiguraci

---

## Fáze 5: Fallback na Abacus.ai (pokud Live API nefunguje)

### Úkoly
1. Přidat Abacus API klíč do nastavení
2. Implementovat transkripci (Whisper nebo interní)
3. Přidat model selector pro Abacus modely
4. Doporučený model: `gpt-4o-mini` nebo `gemini-2.5-flash`

---

## Akční plán (Další kroky)

| # | Akce | Stav |
|---|------|------|
| 1 | Deploy poslední opravy (model mapping) | ✅ Hotovo |
| 2 | Uživatel otestuje na mobilu | ⏳ Čeká |
| 3 | Zkontrolovat log - jaký model se zobrazuje? | ⏳ |
| 4 | Pokud stále 1006, zkusit Test 2-5 | ⏳ |
| 5 | Rozhodnout: Live API nebo Abacus | ⏳ |

---

## Poznámky

Před přechodem na Abacus nutno vyčerpat:
1. Všechna alternativní model ID
2. Všechny endpoint verze
3. Test na jiném prohlížeči/zařízení

Časový limit: Pokud do 3 pokusů (různé konfigurace) nebude úspěch, přejít na Abacus.
