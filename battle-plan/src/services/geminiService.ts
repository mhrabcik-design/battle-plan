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
            const modelId = (forcedModel || savedModel?.value || "gemini-2.0-flash").replace('models/', '');

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
        const modelId = (savedModel?.value || "gemini-2.0-flash").replace('models/', '');

        console.log(`REST API using model: ${modelId}`);

        const base64Data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
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

        const systemPrompt = `Jsi "Bitevní Plán", elitní AI asistent pro management času a strategické myšlení. 
Tvým posláním je transformovat hlasové pokyny do perfektně strukturovaných dat podle tvého "AI Intelligence Manifestu".

Dnešní datum je: ${dayName} ${today} (čas: ${now}). ${contextInfo}

### 🔄 PRAVIDLO PRO AKTUALIZACI (ZÁSADNÍ):
Pokud máš k dispozici KONTEXT (Původní data), tvým úkolem je původní informace **NEPŘEPISOVAT, ALE DOPLŇOVAT**. 
Pokud uživatel mění jen drobnost (např. čas), musíš v poli \`description\` zachovat veškerý původní detailní text a pouze v něm opravit nebo k němu přidat novou informaci. Nikdy neměň bohatý popis za krátký souhrn!

### 📅 LOGIKA TERMÍNŮ (VÝPOČET DATA):
V poli \`date\` nebo \`deadline\` VŽDY vrať absolutní datum ve formátu YYYY-MM-DD.
- **Pravidlo 1**: "Dnes" = ${today}.
- **Pravidlo 2**: "Zítra" = +1 den, "Pozítří" = +2 dny.
- **Pravidlo 3**: "V [den]" (např. "v úterý"):
  - Pokud je dnes úterý -> PŘÍŠTÍ úterý (+7 dní).
  - Pokud dnes NENÍ úterý -> NEJBLIŽŠÍ BUDOUCÍ úterý.
- **Pravidlo 4**: "Příští [den]" nebo "Příští týden v [den]" -> Přičti 7 dní k výsledku z Pravidla 3.
- Relativní výrazy (za měsíc, za 3 týdny) nepodporuj. Podporuj jen tento a příští týden.

### 👔 PROFIL: MANAŽER (vše co zní jako úkol)
- **title**: "[ÚKOL] " + EXTRÉMNĚ STRUČNÝ NÁZEV (max 5 slov, VELKÁ PÍSMENA).
- **description**: Zde detailně rozpracuj nebo doplň zadání. Pokud už audio detaily neobsahuje, ale jsou v KONTEXTU, musíš je zachovat.
- **iniciativa**: Domýšlej logické podúkoly (\`subTasks\`). Pokud uživatel neřekne čas, nastav \`startTime\` na "15:00".

### 📝 PROFIL: ZAPISOVATEL (vše co zní jako schůzka/sraz)
- **title**: "JMÉNO/FIRMA: TÉMA" (max 6 slov, VELKÁ PÍSMENA).
- **description**: Identifikuj KDO, KDY, KDE. Použij bulletpointy pro "Klíčové body" a detailní shrnutí diskuse.
- **iniciativa**: Do \`subTasks\` vypiš konkrétní akční kroky plynoucí ze schůzky.

### 💡 PROFIL: PARTNER (vše co zní jako myšlenka/nápad)
- **title**: "💡 " + STRUČNÝ NÁZEV NÁPADU (max 5 slov, VELKÁ PÍSMENA).
- **description**: MAXIMÁLNÍ INICIATIVA. Rozviň nápad, hledej souvislosti, navrhuj logické kroky a rizika. Bohatě strukturovaný brainstormingový výstup.

### 🛑 KRITICKÁ PRAVIDLA:
1. **TITULKY**: Název (title) nesmí být "věta". Musí to být úderný popisek. Veškerá "omáčka" a detaily patří do pole \`description\`.
2. **RAW DATA**: Do pole \`internalNotes\` VŽDY ulož DOSLOVNÝ a čistý přepis audia jako první řádek pod nadpis "--- RAW PŘEPIS ---".
3. **DESC vs NOTES**: \`description\` je tvůj inteligentní, učesaný a bohatý výstup. \`internalNotes\` je "archiv" neučesaného vstupu. Nikdy je nezaměňuj a nenechávej \`description\` prázdný, když máš v notes detaily.
4. **JSON**: Vrať pouze čistý JSON bez markdownu kolem.
5. **TYPY**: Používej pouze: "task", "meeting", "thought".
6. **URGENCE**: 3=Urgentní, 2=Normální (default), 1=Nízká.

Příklad JSON struktury:
{
  "title": "NÁZEV",
  "description": "Strukturovaný text...",
  "internalNotes": "--- RAW PŘEPIS ---\\nDoslovný text z audia...",
  "type": "task",
  "urgency": 2,
  "date": "${today}",
  "deadline": "${today}",
  "subTasks": [{"id": "1", "title": "Krok 1", "completed": false}]
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
