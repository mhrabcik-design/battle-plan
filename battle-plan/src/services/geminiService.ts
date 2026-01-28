import { db, type Task } from '../db';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class GeminiService {
    private apiKey: string | null = null;

    async init() {
        try {
            const setting = await db.settings.get('gemini_api_key');
            this.apiKey = setting?.value || null;
            console.log("GeminiService initialized, API Key present:", !!this.apiKey);
        } catch (e) {
            console.error("Failed to init GeminiService", e);
        }
    }

    async listModels(): Promise<string> {
        try {
            if (!this.apiKey) await this.init();
            if (!this.apiKey) return "API klíč nebyl nalezen v databázi.";

            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`;
            const response = await fetch(url);
            const data = await response.json();

            if (!response.ok) return `Chyba API (${response.status}): ${data.error?.message || 'Neznámý problém'}`;
            if (!data.models) return "Server nevrátil žádné modely.";

            const models = data.models
                .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
                .map((m: any) => m.name.replace('models/', ''));

            return models.length > 0
                ? `Dostupné modely:\n${models.join('\n')}`
                : "Nebyly nalezeny žádné vhodné modely.";
        } catch (e: any) {
            console.error("listModels error", e);
            return `Chyba při komunikaci: ${e.message}`;
        }
    }

    async testConnection(forcedModel?: string): Promise<string> {
        try {
            if (!this.apiKey) await this.init();
            if (!this.apiKey) return "Chybí API klíč.";

            const savedModel = await db.settings.get('gemini_model');
            const modelId = (forcedModel || savedModel?.value || "gemini-1.5-flash").replace('models/', '');

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${this.apiKey}`;

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: "Ahoj" }] }]
                })
            });

            const data = await response.json();
            if (!response.ok) return `Chyba ${modelId}: ${data.error?.message || 'Neznámý problém'}`;

            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "Žádná odpověď";
            return `Spojení s ${modelId} OK: ${text}`;
        } catch (e: any) {
            console.error("testConnection error", e);
            return `Chyba testu: ${e.message}`;
        }
    }

    async processAudio(blob: Blob, contextId?: number, onRetry?: (attempt: number, delay: number) => void): Promise<Partial<Task> | null> {
        if (!this.apiKey) await this.init();
        if (!this.apiKey) throw new Error("API klíč nebyl nalezen.");

        const savedModel = await db.settings.get('gemini_model');
        const modelId = (savedModel?.value || "gemini-1.5-flash").replace('models/', '');

        console.log(`REST API using model: ${modelId}`);

        const base64Data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });

        const today = new Date().toISOString().split('T')[0];
        const now = new Date().toTimeString().split(' ')[0];

        let contextInfo = "";
        if (contextId) {
            const existingTask = await db.tasks.get(contextId);
            if (existingTask) {
                contextInfo = `\n\nPOZOR - KONTEXT PRO AKTUALIZACI (Tato data jsou PŘEKONANÁ novým audiem):
- Původní název (k přepsání): ${existingTask.title}
- Původní popis (k přepsání): ${existingTask.description}
- Původní typ: ${existingTask.type}
- Původní datum: ${existingTask.date}
- Původní interní poznámky: ${existingTask.internalNotes || ""}`;
            }
        }

        const systemPrompt = `Jsi "Bitevní Plán", elitní AI asistent pro management času. 
Tvým posláním je transformovat hlasové pokyny do perfektně strukturovaných dat.

Dnešní datum je: ${today} (čas: ${now}). ${contextInfo}

Z audia vytvoř POUZE JSON objekt:
- title: KRÁTKÝ, ÚDERNÝ (MAX 5 SLOV, VELKÁ PÍSMENA). Pro schůzky povinně: "JMÉNO: TÉMA".
- description: Čistá esence záznamu.
- internalNotes: Původní řetězec + Nové poznámky.
- type, urgency, deadline, startTime, duration:
    - **ÚKOLY (task)**: Vždy nastavuj \`deadline\`. Pokud uživatel neřekne čas, nastav \`startTime\` na "15:00". Pokud uživatel neřekne datum, nastav dnešek. Pole \`date\` IGNORUJ.
    - **SCHŮZKY (meeting)**: Nastavuj \`date\` i \`startTime\`.
- **DŮLEŽITÉ - URGENCE (1-3)**: 3=Urgentní, 2=Normální (DEFAULT), 1=Bez urgentnosti.

DŮLEŽITÉ POKYNY:
1. **DEADLINE PŘEDNOST**: Pro úkoly je termín dokončení (deadline) absolutní priorita.
2. **KAPACITA**: Pokud uživatel zmíní náročnost (např. "zabere mi to 5 hodin"), nastav \`duration\` na 300.

Příklad RADIKÁLNÍ AKTUALIZACE:
Audio: "Změň tu schůzku, už to není s Petrem ale s Honzou v kanclu a název dej NOMINACE."
Výsledek JSON:
{
  "title": "HONZA: NOMINACE",
  "description": "KDO: Honza | KDE: Kancelář | TÉMA: Nominace kandidátů",
  "type": "meeting"
}`;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${this.apiKey}`;

        const maxAttempts = 4;
        let lastError: any = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: systemPrompt },
                                { inline_data: { mime_type: blob.type || "audio/webm", data: base64Data } }
                            ]
                        }]
                    })
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    const msg = errorData.error?.message || 'Neznámý problém';

                    // Pokud je to chyba přetížení (429) nebo serveru (5xx), zkusíme to znovu
                    if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
                        const delay = attempt * 2000; // 2s, 4s, 6s
                        console.warn(`Attempt ${attempt} failed (status ${response.status}). Retrying in ${delay}ms...`);
                        if (onRetry) onRetry(attempt, delay);
                        await sleep(delay);
                        continue;
                    }

                    throw new Error(`AI Chyba: ${msg}`);
                }

                const data = await response.json();
                const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!responseText) throw new Error("AI nevrátila žádnou odpověď.");

                try {
                    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                    return JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
                } catch (e) {
                    console.error("JSON parse error", responseText);
                    throw new Error("Chyba při parsování dat od AI.");
                }

            } catch (err: any) {
                lastError = err;
                // Pokud to nebyla chyba, kterou chceme opakovat (nebo už jsme na konci), vyhodíme ji
                if (attempt === maxAttempts) throw err;

                // Síťové chyby (Failed to fetch) taky zkusíme znovu
                if (err.message?.includes('fetch') || err.message?.includes('Network')) {
                    const delay = attempt * 2000;
                    if (onRetry) onRetry(attempt, delay);
                    await sleep(delay);
                    continue;
                }
                throw err;
            }
        }

        throw lastError || new Error("AI zpracování selhalo po opakovaných pokusech.");
    }
}

export const geminiService = new GeminiService();
