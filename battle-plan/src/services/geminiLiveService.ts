import { db } from '../db';

export class GeminiLiveService {
    private socket: WebSocket | null = null;
    private apiKey: string | null = null;
    private model = 'gemini-2.0-flash-exp'; // Standard Live model, user screenshot showed 2.5 flash native audio dialog

    async init() {
        const setting = await db.settings.get('gemini_api_key');
        this.apiKey = setting?.value || null;
        const modelSetting = await db.settings.get('gemini_model');
        if (modelSetting?.value.includes('native-audio')) {
            this.model = modelSetting.value;
        }
    }

    async connect(onMessage: (data: any) => void, onError: (err: any) => void) {
        if (!this.apiKey) await this.init();
        if (!this.apiKey) {
            onError("API klíč nebyl nalezen.");
            return;
        }

        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BiDiGenerateContent?key=${this.apiKey}`;

        this.socket = new WebSocket(url);

        this.socket.onopen = () => {
            console.log("Gemini Live WebSocket connected");

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

            // Send setup message
            const setup = {
                setup: {
                    model: `models/${this.model}`,
                    generation_config: {
                        response_modalities: ["text"]
                    },
                    system_instruction: {
                        parts: [{ text: systemPrompt }]
                    }
                }
            };
            this.socket?.send(JSON.stringify(setup));
        };

        this.socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
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
            console.error("WebSocket error", err);
            onError("Připojení k AI selhalo.");
        };

        this.socket.onclose = () => {
            console.log("Gemini Live WebSocket closed");
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
