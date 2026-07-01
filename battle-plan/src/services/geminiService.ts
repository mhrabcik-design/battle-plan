import { db, type Task } from '../db';
import {
    fetchWithTimeout,
    getErrorMessage,
    getRetryDelay,
    isAbortError,
    isRetryableFetchError,
    prepareGeminiAudio,
    sleep,
} from './audioAiPipeline';
import { getSystemPrompt } from './semanticEngine';
export const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';
export const AVAILABLE_GEMINI_MODELS = [
    DEFAULT_GEMINI_MODEL,
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
];

interface GeminiErrorResponse {
    error?: {
        message?: string;
    };
}

interface GeminiModelListItem {
    name: string;
    supportedGenerationMethods?: string[];
}

interface GeminiModelListResponse extends GeminiErrorResponse {
    models?: GeminiModelListItem[];
}

export class GeminiService {
    private apiKey: string | null = null;
    private initPromise: Promise<void> | null = null;
    private cachedModel: string | null = null;

    async init() {
        if (this.initPromise) return this.initPromise;
        this.initPromise = this._init();
        return this.initPromise;
    }

    private async _init() {
        try {
            const setting = await db.settings.get('gemini_api_key');
            this.apiKey = setting?.value || null;
            console.log("GeminiService initialized, API Key present:", !!this.apiKey);
        } catch (e) {
            console.error("Failed to init GeminiService", e);
        }
    }

    private async getModel(): Promise<string> {
        if (this.cachedModel) return this.cachedModel;
        const savedModel = await db.settings.get('gemini_model');
        this.cachedModel = (savedModel?.value || DEFAULT_GEMINI_MODEL).replaceAll('models/', '');
        return this.cachedModel;
    }

    clearModelCache() {
        this.cachedModel = null;
    }

    async listModels(): Promise<string> {
        try {
            if (!this.apiKey) await this.init();
            if (!this.apiKey) return "API klíč nebyl nalezen v databázi.";

            const url = 'https://generativelanguage.googleapis.com/v1beta/models';
            const response = await fetchWithTimeout(url, {
                headers: { 'x-goog-api-key': this.apiKey }
            });
            const data = await response.json() as GeminiModelListResponse;

            if (!response.ok) return `Chyba API (${response.status}): ${data.error?.message || 'Neznámý problém'}`;
            if (!data.models) return "Server nevrátil žádné modely.";

            const models = data.models
                .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
                .map((m) => m.name.replaceAll('models/', ''));

            return models.length > 0
                ? `Dostupné modely:\n${models.join('\n')}`
                : "Nebyly nalezeny žádné vhodné modely.";
        } catch (e: unknown) {
            if (isAbortError(e)) return "Požadavek vypršel (timeout).";
            console.error("listModels error", e);
            return `Chyba při komunikaci: ${getErrorMessage(e)}`;
        }
    }

    async testConnection(forcedModel?: string): Promise<string> {
        try {
            if (!this.apiKey) await this.init();
            if (!this.apiKey) return "Chybí API klíč.";

            const modelId = (forcedModel || await this.getModel()).replaceAll('models/', '');
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;

            const response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': this.apiKey
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: "Ahoj" }] }]
                })
            });

            const data = await response.json() as GeminiErrorResponse & {
                candidates?: { content?: { parts?: { text?: string }[] } }[];
            };
            if (!response.ok) return `Chyba ${modelId}: ${data.error?.message || 'Neznámý problém'}`;

            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "Žádná odpověď";
            return `Spojení s ${modelId} OK: ${text}`;
        } catch (e: unknown) {
            if (isAbortError(e)) return "Požadavek vypršel (timeout).";
            console.error("testConnection error", e);
            return `Chyba testu: ${getErrorMessage(e)}`;
        }
    }

    private processingLock = false;

    async processAudio(blob: Blob, contextId?: number, onRetry?: (attempt: number, delay: number) => void): Promise<Partial<Task> | null> {
        if (this.processingLock) throw new Error("Zpracování již probíhá. Vyčkejte prosím.");
        this.processingLock = true;

        try {
            if (!this.apiKey) await this.init();
            if (!this.apiKey) throw new Error("API klíč nebyl nalezen.");

            const modelId = await this.getModel();
            const audio = await prepareGeminiAudio(blob);

            console.log(`REST API using model: ${modelId}`);

            const nowObj = new Date();
            const today = nowObj.toISOString().split('T')[0];
            const now = nowObj.toTimeString().split(' ')[0];
            const dayNames = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];
            const dayName = dayNames[nowObj.getDay()];

            let contextInfo = "";
            if (contextId) {
                const existingTask = await db.tasks.get(contextId);
                if (existingTask) {
                    contextInfo = `\n\nPOZOR - KONTEXT PRO AKTUALIZACI (Původní data k zachování a doplnění):
- Původní název (k zachování/úpravě): ${existingTask.title}
- Původní popis (ZDE JSOU KLÍČOVÉ DETAILY, KTERÉ NESMÍŠ ZTRATIT): ${existingTask.description}
- Původní typ: ${existingTask.type}
- Původní datum: ${existingTask.date}
- Původní interní poznámky: ${existingTask.internalNotes || ""}`;
                }
            }

            const systemPrompt = getSystemPrompt(dayName, today, now, contextInfo);
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;

            const maxAttempts = 4;
            let lastError: unknown = null;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    const response = await fetchWithTimeout(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': this.apiKey
                        },
                        body: JSON.stringify({
                            contents: [{
                                parts: [
                                    { text: systemPrompt },
                                    { inline_data: { mime_type: audio.mimeType, data: audio.base64Data } }
                                ]
                            }],
                            generation_config: {
                                response_mime_type: "application/json"
                            }
                        })
                    });

                    if (!response.ok) {
                        let msg = 'Neznámý problém';
                        try {
                            const errorData = await response.json() as GeminiErrorResponse;
                            msg = errorData.error?.message || msg;
                        } catch (parseError) {
                            console.warn('Failed to parse Gemini error response', parseError);
                        }

                        if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
                            const delay = getRetryDelay(attempt);
                            console.warn(`Attempt ${attempt} failed (status ${response.status}). Retrying in ${delay}ms...`);
                            if (onRetry) onRetry(attempt, delay);
                            await sleep(delay);
                            continue;
                        }

                        throw new Error(`AI Chyba: ${msg}`);
                    }

                    const data = await response.json() as {
                        candidates?: { content?: { parts?: { text?: string }[] } }[];
                    };
                    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (!responseText) throw new Error("AI nevrátila žádnou odpověď.");

                    try {
                        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                        return JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
                    } catch {
                        console.error("JSON parse error", responseText);
                        throw new Error("Chyba při parsování dat od AI.");
                    }

                } catch (err: unknown) {
                    lastError = err;
                    if (attempt === maxAttempts) {
                        throw err instanceof Error ? err : new Error(getErrorMessage(err));
                    }

                    if (isRetryableFetchError(err)) {
                        const delay = getRetryDelay(attempt);
                        if (onRetry) onRetry(attempt, delay);
                        await sleep(delay);
                        continue;
                    }
                    throw err;
                }
            }

            throw lastError instanceof Error ? lastError : new Error("AI zpracování selhalo po opakovaných pokusech.");
        } finally {
            this.processingLock = false;
        }
    }
}

export const geminiService = new GeminiService();
