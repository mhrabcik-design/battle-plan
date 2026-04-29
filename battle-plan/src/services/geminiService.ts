import { db, type Task } from '../db';
import { getSystemPrompt } from './semanticEngine';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const FETCH_TIMEOUT = 30000;
export const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';
export const AVAILABLE_GEMINI_MODELS = [
    DEFAULT_GEMINI_MODEL,
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
];

const GEMINI_INLINE_AUDIO_MIME_TYPES = new Set([
    'audio/wav',
    'audio/mp3',
    'audio/mpeg',
    'audio/aiff',
    'audio/aac',
    'audio/ogg',
    'audio/flac',
]);

type WindowWithWebkitAudio = typeof window & {
    webkitAudioContext?: typeof AudioContext;
};

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

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

function isRetryableFetchError(error: unknown): boolean {
    return isAbortError(error)
        || error instanceof TypeError
        || (error instanceof Error && error.message.includes('Failed to fetch'));
}

function fetchWithTimeout(url: string, options: RequestInit, timeout: number = FETCH_TIMEOUT): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

function normalizeMimeType(mimeType: string): string {
    return mimeType.split(';')[0]?.trim().toLowerCase() || '';
}

function writeAscii(view: DataView, offset: number, value: string) {
    for (let i = 0; i < value.length; i++) {
        view.setUint8(offset + i, value.charCodeAt(i));
    }
}

function audioBufferToWavBlob(audioBuffer: AudioBuffer): Blob {
    const sampleRate = audioBuffer.sampleRate;
    const sampleCount = audioBuffer.length;
    const bytesPerSample = 2;
    const channelCount = 1;
    const dataSize = sampleCount * channelCount * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channelCount, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
    view.setUint16(32, channelCount * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, i) => audioBuffer.getChannelData(i));
    let offset = 44;
    for (let i = 0; i < sampleCount; i++) {
        const mixedSample = channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length;
        const sample = Math.max(-1, Math.min(1, mixedSample));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += bytesPerSample;
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

async function convertToWav(blob: Blob): Promise<Blob> {
    const AudioContextCtor = window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext;
    if (!AudioContextCtor) throw new Error('Prohlížeč neumí dekódovat audio pro převod do WAV.');

    const audioContext = new AudioContextCtor();
    try {
        const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
        return audioBufferToWavBlob(decoded);
    } finally {
        await audioContext.close();
    }
}

async function normalizeAudioForGemini(blob: Blob): Promise<Blob> {
    const mimeType = normalizeMimeType(blob.type);
    if (mimeType && GEMINI_INLINE_AUDIO_MIME_TYPES.has(mimeType) && !blob.type.includes('codecs=')) {
        return blob;
    }

    try {
        return await convertToWav(blob);
    } catch (e) {
        console.error('Audio normalization failed', e);
        throw new Error(`Nahrávku se nepodařilo převést do formátu WAV. Původní typ: ${blob.type || 'neznámý'}.`);
    }
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
            const normalizedBlob = await normalizeAudioForGemini(blob);

            console.log(`REST API using model: ${modelId}`);

            const base64Data = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(normalizedBlob);
            });

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
                                    { inline_data: { mime_type: normalizeMimeType(normalizedBlob.type) || "audio/wav", data: base64Data } }
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
                            const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 10000);
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
                        const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 10000);
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
