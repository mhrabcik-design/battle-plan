import { db, type Task } from '../db';

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

    async processAudio(blob: Blob, contextId?: number): Promise<Partial<Task> | null> {
        if (!this.apiKey) await this.init();
        if (!this.apiKey) throw new Error("API klíč nebyl nalezen.");

        const savedModel = await db.settings.get('gemini_model');
        const modelId = (savedModel?.value || "gemini-1.5-flash").replace('models/', '');

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
                contextInfo = `\n\nPOZOR: AKTUALIZUJEŠ EXISTUJÍCÍ ZÁZNAM:
- Původní název: ${existingTask.title}
- Původní popis: ${existingTask.description}
- Původní interní poznámky: ${existingTask.internalNotes || ""}
- Původní typ: ${existingTask.type}
- Původní datum: ${existingTask.date}
- Původní důležitost: ${existingTask.urgency}
- Původní pod-úkoly: ${JSON.stringify(existingTask.subTasks || [])}
- Původní progres: ${existingTask.progress || 0}%`;
            }
        }

        const systemPrompt = `Jsi "Bitevní Plán", vysoce efektivní asistent pro plánování času. 
Tvým úkolem je analyzovat zvukový záznam (v češtině) a extrahovat z něj strukturovaná data pro systém IndexedDB.

Dnešní datum je: ${today} (čas: ${now}). ${contextInfo}

Z audia vytvoř POUZE JSON objekt s těmito poli:
- title: Krátký, úderný název (max 5 slov, velká písmena).
- description: Veřejný shrnující popis.
- internalNotes: Interní detaily, podrobné zápisy ze schůzek (např. co se domluvilo při cestě autem).
- type: 'task' (úkol), 'meeting' (schůzka) nebo 'thought' (myšlenka).
- urgency: Číslo 1 až 5.
- duration: Odhadovaná délka v minutách (číslo).
- date: Datum zahájení (YYYY-MM-DD).
- deadline: Datum uzávěrky (YYYY-MM-DD).
- subTasks: Pole objektů [{ id: string, title: string, completed: boolean }]. Buď INICIATIVNÍ: pokud je úkol komplexní, automaticky ho rozděl na logické pod-úkoly.
- progress: Číslo 0-100. AI odhadne progres na základě splněných pod-úkolů nebo obsahu audia.

DŮLEŽITÉ POKYNY:
1. PŘI AKTUALIZACI: Pokud uživatel doplňuje informace ("zapiš si ze schůzky...", "doplň k úkolu..."), ulož to primárně do "internalNotes". 
2. Zachovej původní title a description, pokud nejsou měněny.
3. Pokud uživatel nadiktuje seznam věcí ("musím udělat A, B a C"), vytvoř z nich "subTasks".
4. Vrať POUZE čistý JSON. Žádný text okolo.

Příklad výstupu pro komplexní úkol:
{
  "title": "NÁVRH PROJEKTU",
  "type": "task",
  "subTasks": [
    { "id": "1", "title": "Analýza požadavků", "completed": false },
    { "id": "2", "title": "Náčrt architektury", "completed": false }
  ],
  "progress": 0
}`;


        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${this.apiKey}`;

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
            throw new Error(`AI Chyba: ${errorData.error?.message || 'Neznámý problém'}`);
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
    }
}

export const geminiService = new GeminiService();
