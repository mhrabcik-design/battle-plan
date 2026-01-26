# PLAN: Gemini 2.5 Flash Native Audio (Version 3.0)

## Cíl
Implementace **Multimodal Live API** pro využití modelu `gemini-2.5-flash-native-audio-dialog`, který nabízí neomezené limity (Unlimited RPM/RPD) v aktuálním tieru.

## 🏗️ Fáze 1: Verze a Konfigurace
- [ ] **Major Bump:** Aktualizace `package.json` na verzi `3.0.0`.
- [ ] **Model Registry:** Přidání `gemini-2.5-flash-native-audio-dialog` do seznamu modelů v `App.tsx`.
- [ ] **UI Update:** Přidání vizuálního indikátoru "Live Mode" do Focus Mode.

## 🔌 Fáze 2: Gemini Live Service (WebSocket)
- [ ] **Třída `GeminiLiveService`:** Implementace WebSocket klienta pro endpoint `wss://generativelanguage.googleapis.com/...`.
- [ ] **Handshake:** Odeslání inicializační zprávy (`setup`) s modelem a stávajícím system promptem.
- [ ] **Output Handler:** Záchyt textových zpráv z WebSoketu a jejich parsování do JSONu.

## 🎙️ Fáze 3: Audio Streaming Pipeline
- [ ] **PCM Konverze:** Úprava nahrávání na **RAW PCM 16-bit (16kHz)**.
- [ ] **Real-time Chunks:** Odesílání Base64 úseků zvuku hned po jejich zachycení.

## ⚠️ Fáze 4: Chybové stavy a Verifikace
- [ ] **Connection Error:** Hláška "Připojení selhalo" při pádu WebSocketu.
- [ ] **Test:** Ověření funkčnosti neomezeného diktování.

## 🏁 Checklist pro Verifikaci
1. Verze v aplikaci je 3.0.0.
2. WebSocket spojení se otevře při startu nahrávání.
3. Audio kvalita je nastavena na 16kHz PCM.
4. AI správně extrahuje úkoly bez fallbacku na REST.
