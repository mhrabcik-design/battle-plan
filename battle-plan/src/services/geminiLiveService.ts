import { db } from '../db';

export class GeminiLiveService {
    private socket: WebSocket | null = null;
    private apiKey: string | null = null;
    private logCallback: ((m: string, type: 'info' | 'error') => void) | null = null;
    private model = 'gemini-2.0-flash-exp';

    async init() {
        const setting = await db.settings.get('gemini_api_key');
        this.apiKey = setting?.value || null;
        const modelSetting = await db.settings.get('gemini_model');
        if (modelSetting?.value) {
            this.model = modelSetting.value;
        }
    }

    setLogger(callback: (m: string, type: 'info' | 'error') => void) {
        this.logCallback = callback;
    }

    async connect(onMessage: (data: any) => void, onError: (err: any) => void) {
        if (!this.apiKey) await this.init();
        if (!this.apiKey) {
            onError("API klíč nebyl nalezen.");
            return;
        }

        const host = "generativelanguage.googleapis.com";
        const path = "ws/google.ai.generativelanguage.v1beta.GenerativeService.BiDiGenerateContent";
        // Pridavame alt=json pro jistotu, nektere proxy to vyzaduji
        const url = `wss://${host}/${path}?key=${this.apiKey}&alt=json`;

        this.logCallback?.(`Připojování k Gemini Live: models/${this.model}`, 'info');
        console.log(`Connecting to Gemini Live: wss://${host}/${path}?key=***${this.apiKey.slice(-4)}`);
        this.socket = new WebSocket(url);

        this.socket.onopen = () => {
            this.logCallback?.("WebSocket otevřen, posílám setup...", 'info');
            console.log("Gemini Live WebSocket connected");

            this.logCallback?.(`Posílám setup pro model: models/${this.model}`, 'info');

            // Send clean setup first
            const setup = {
                setup: {
                    model: `models/${this.model}`,
                    generation_config: {
                        response_modalities: ["text"]
                    }
                }
            };
            this.socket?.send(JSON.stringify(setup));
            this.logCallback?.("Setup odeslán (minimal).", 'info');

            // Optional: System prompt can be sent as an initial content if needed, 
            // but let's see if the connection holds first.
        };

        this.socket.onmessage = (event) => {
            this.logCallback?.(`Přijata zpráva: ${event.data.length > 200 ? event.data.length + ' bajtů' : event.data}`, 'info');
            try {
                const data = JSON.parse(event.data);

                // Handle setup completion
                if (data.setupComplete) {
                    this.logCallback?.("Setup potvrzen serverem. Posílám instrukce...", 'info');

                    const today = new Date().toISOString().split('T')[0];
                    const now = new Date().toTimeString().split(' ')[0];
                    const systemPrompt = `Jsi "Bitevní Plán", elitní AI asistent pro management času. 
Dnešní datum je: ${today} (čas: ${now}).
Z audia vytvoř POUZE JSON objekt:
- title: KRÁTKÝ, ÚDERNÝ (MAX 5 SLOV, VELKÁ PÍSMENA).
- description: Čistá esence záznamu.
- type, urgency, date, startTime, duration, progress.
- URGENCE (1-3): 3=Urgentní, 2=Normální (DEFAULT), 1=Bez urgentnosti.
Vracíš POUZE čistý JSON.`;

                    const firstMessage = {
                        client_content: {
                            turns: [
                                {
                                    role: "user",
                                    parts: [{ text: systemPrompt }]
                                }
                            ],
                            turn_complete: true
                        }
                    };
                    this.socket?.send(JSON.stringify(firstMessage));
                    return;
                }

                // The Live API returns delta updates or final responses
                if (data.serverContent?.modelTurn?.parts?.[0]?.text) {
                    const text = data.serverContent.modelTurn.parts[0].text;
                    const jsonMatch = text.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        onMessage(JSON.parse(jsonMatch[0]));
                    }
                }
            } catch (e) {
                console.error("WebSocket message processing error", e);
            }
        };

        this.socket.onerror = (err) => {
            this.logCallback?.(`WebSocket Error: ${JSON.stringify(err)}`, 'error');
            console.error("Gemini Live WebSocket error:", err);
            onError(`Spojení s AI selhalo. Zkontrolujte připojení k internetu nebo API klíč.`);
        };

        this.socket.onclose = (event) => {
            this.logCallback?.(`WebSocket Closed: ${event.code} ${event.reason}`, event.wasClean ? 'info' : 'error');
            console.log("Gemini Live WebSocket closed", event.code, event.reason);
            if (!event.wasClean) {
                let detail = "";
                if (event.code === 1006) detail = "(Abnormal Closure - často blokováno firewall/proxy nebo špatné URL)";
                if (event.code === 4000) detail = "(Neplatný API klíč)";
                onError(`AI spojení přerušeno: ${event.code} ${event.reason || detail}`);
            }
        };
    }

    sendAudio(base64Audio: string) {
        if (this.socket?.readyState === WebSocket.OPEN) {
            const message = {
                realtime_input: {
                    media_chunks: [
                        {
                            mime_type: "audio/pcm;rate=16000",
                            data: base64Audio
                        }
                    ]
                }
            };
            this.socket.send(JSON.stringify(message));
        }
    }

    finish() {
        if (this.socket?.readyState === WebSocket.OPEN) {
            // Live API doesn't have a specific "end of stream" trigger in the same way REST does, 
            // usually you just stop sending and wait for the model to finish speaking/responding 
            // or you send a specific control message if supported.
            // For our "invisible" use case, we might send an empty text prompt to trigger final JSON generation if needed.
        }
    }

    disconnect() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }
}

export const geminiLiveService = new GeminiLiveService();
