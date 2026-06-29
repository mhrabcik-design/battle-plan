/* eslint-disable @typescript-eslint/no-explicit-any */
import { db, type WorkLog, type Project } from '../db';

/**
 * WorkLog extractor — z Gemini audio transkripce vytáhne strukturovaný WorkLog.
 *
 * Volá se z App.tsx, když `viewMode === 'worklogs'`. Vrací buď:
 *   - { workLog: {...} } při úspěchu (validní + projekt nalezen)
 *   - { needsProjectMatch: { ... } } když AI nenašel projekt v seznamu
 *   - { error: string } při chybě
 */

export const WORKLOG_SYSTEM_PROMPT = `
Jsi asistent pro evidenci pracovních činností elektroinstalační firmy.
Z diktovaného textu (v češtině) extrahuj PŘESNĚ tyto informace do JSON:

{
  "projectName": string,        // název projektu (zachovej přesně jak uživatel říká)
  "people": string,             // jména oddělená čárkou (zachovej přesně, např. "Pepa, Lukáš"). Prázdné string "" pokud nikdo nezmíněn.
  "hours": number,              // počet hodin (desetinné číslo povoleno: 8, 8.5, 7.25)
  "description": string,        // co se dělalo (volitelné, vynech pokud nic)
  "date": string                // ISO YYYY-MM-DD (dnes, pokud nezmíněno jinak)
}

Pravidla:
- Pokud uživatel řekne "včera" → date = včerejší den
- Pokud uživatel řekne "dneska" nebo "dnes" → date = dnešní den
- Pokud řekne konkrétní datum ("15. června") → převeď na YYYY-MM-DD
- Pokud zmíní víc lidí: "Pepa, Lukáš a Tom" → "Pepa, Lukáš, Tom"
- Pokud nezmíní projekt: projectName = ""
- Pokud nezmíní lidi: people = ""
- Pokud nezmíní hodiny: uhodni z kontextu (např. "celý den" = 8)
- Pokud nezmíní co dělali: description = ""

Příklad vstupu: "Včera na KB Plaza, byli tam se mnou Pepa a Lukáš, dělali jsme 8 hodin, tahali kabely v 3. patře"
Příklad výstupu: {
  "projectName": "KB Plaza",
  "people": "Pepa, Lukáš",
  "hours": 8,
  "description": "tahali kabely v 3. patře",
  "date": "2026-06-28"
}

Vrať POUZE čistý JSON bez markdownu.
`.trim();

/** Výsledek extrakce — buď ready k uložení, nebo potřebuje doplnit projekt, nebo chyba. */
export type WorkLogExtractionResult =
    | { ok: true; data: { projectName: string; people: string; hours: number; description: string; date: string } }
    | { ok: false; error: string };

/** Extrahovaná data z Gemini (ještě bez projectId). */
export interface ExtractedWorkLog {
    projectName: string;
    people: string;
    hours: number;
    description?: string;
    date: string;
}

/** Pokusí se najít projekt v DB — case-insensitive match, přesná shoda, contains. */
export async function findProjectByName(name: string, allProjects: Project[]): Promise<Project | null> {
    if (!name || !name.trim()) return null;
    const needle = name.trim().toLowerCase();
    // 1. Přesná shoda (case-insensitive)
    const exact = allProjects.find((p) => p.isActive && p.name.toLowerCase() === needle);
    if (exact) return exact;
    // 2. Obsahuje (exact v needlu nebo needle v exact)
    const partial = allProjects.find(
        (p) => p.isActive && (p.name.toLowerCase().includes(needle) || needle.includes(p.name.toLowerCase()))
    );
    return partial ?? null;
}

/**
 * Sanituje výstup z Gemini — validuje typy, doplní defaults, normalizuje.
 * Vrací buď hotová data, nebo chybovou hlášku.
 */
export function sanitizeExtractedWorkLog(raw: any): WorkLogExtractionResult {
    if (!raw || typeof raw !== 'object') {
        return { ok: false, error: 'AI nevrátilo žádná data' };
    }

    // Hodiny — povinné, > 0, <= 24
    const hours = Number(raw.hours);
    if (Number.isNaN(hours) || hours <= 0 || hours > 24) {
        return { ok: false, error: 'Neplatné hodiny (musí být 0–24)' };
    }

    // Datum — YYYY-MM-DD, fallback dnes
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    let date = typeof raw.date === 'string' ? raw.date.trim() : '';
    if (!dateRegex.test(date)) {
        date = new Date().toISOString().split('T')[0];
    }

    return {
        ok: true,
        data: {
            projectName: typeof raw.projectName === 'string' ? raw.projectName.trim() : '',
            people: typeof raw.people === 'string' ? raw.people.trim() : '',
            hours,
            description: typeof raw.description === 'string' ? raw.description.trim() : '',
            date,
        },
    };
}

/**
 * Aplikuje extrahovaná data — najde projekt, uloží WorkLog.
 * Vrací buď vytvořený WorkLog, nebo potřebu ručního doplnění projektu, nebo chybu.
 */
export type ApplyResult =
    | { ok: true; workLog: WorkLog }
    | { ok: false; error: string }
    | { needsProject: true; extracted: ExtractedWorkLog };

export async function applyExtractedWorkLog(
    extracted: ExtractedWorkLog,
    manualProjectId?: number
): Promise<ApplyResult> {
    const allProjects = await db.projects.toArray();
    const activeProjects = allProjects.filter((p) => p.isActive);

    // 1. Buď ručně zadaný projekt…
    let project: Project | null = null;
    if (manualProjectId) {
        project = activeProjects.find((p) => p.id === manualProjectId) ?? null;
    }

    // 2. …nebo hledáme podle jména
    if (!project) {
        project = await findProjectByName(extracted.projectName, activeProjects);
    }

    if (!project) {
        return { needsProject: true, extracted };
    }

    // 3. Ulož WorkLog
    const now = Date.now();
    const id = await db.workLogs.add({
        date: extracted.date,
        projectId: project.id!,
        projectName: project.name, // použijeme canonical name z DB
        people: extracted.people,
        hours: extracted.hours,
        description: extracted.description || undefined,
        source: 'voice',
        createdAt: now,
        updatedAt: now,
    });

    return {
        ok: true,
        workLog: {
            id: id as number,
            date: extracted.date,
            projectId: project.id!,
            projectName: project.name,
            people: extracted.people,
            hours: extracted.hours,
            description: extracted.description || undefined,
            source: 'voice',
            createdAt: now,
            updatedAt: now,
        },
    };
}

// === Audio processing (paralelní geminiService.processAudio, ale s WorkLog promptem) ===

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const FETCH_TIMEOUT = 30000;

const fetchWithTimeout = async (url: string, options: RequestInit, timeout = FETCH_TIMEOUT): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
};

const normalizeMimeType = (type: string | undefined): string | null => {
    if (!type) return null;
    const supported = new Set(['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/webm']);
    if (supported.has(type)) return type === 'audio/mp3' ? 'audio/mpeg' : type;
    return 'audio/wav';
};

/**
 * Odešle audio do Gemini API s WorkLog extraction promptem a vrátí sanitizovaná data.
 *
 * Pattern kopíruje geminiService.processAudio (retry s exponential backoff),
 * ale používá WorkLog-specifický system prompt.
 */
export async function processWorkLogAudio(
    blob: Blob,
    onRetry?: (attempt: number, delay: number) => void
): Promise<WorkLogExtractionResult> {
    // Získáme API klíč ze stejného zdroje jako geminiService
    const apiKey = await (async () => {
        const setting = await db.settings.get('gemini_api_key');
        return setting?.value ?? '';
    })();

    if (!apiKey) {
        return { ok: false, error: 'API klíč chybí. Nastavte ho v Konfiguraci.' };
    }

    const modelId = (await db.settings.get('gemini_model'))?.value ?? 'gemini-2.5-flash';

    // Normalizace audia (stejný princip jako v geminiService)
    const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
    const maxAttempts = 4;
    let lastError: string = 'Neznámá chyba';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey,
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: WORKLOG_SYSTEM_PROMPT },
                            { inline_data: { mime_type: normalizeMimeType(blob.type) ?? 'audio/wav', data: base64Data } },
                        ],
                    }],
                    generation_config: {
                        response_mime_type: 'application/json',
                    },
                }),
            });

            if (!response.ok) {
                let msg = 'Neznámý problém';
                try {
                    const errorData = await response.json();
                    msg = errorData?.error?.message ?? msg;
                } catch {
                    /* ignore */
                }
                lastError = `${response.status}: ${msg}`;

                if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
                    const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 10000);
                    onRetry?.(attempt, delay);
                    await sleep(delay);
                    continue;
                }
                break;
            }

            const data = await response.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) {
                return { ok: false, error: 'Gemini nevrátilo žádný text' };
            }

            // Parsuj JSON — může být obalen markdown ```json ... ```
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                return { ok: false, error: 'Gemini nevrátilo validní JSON' };
            }

            let parsed: any;
            try {
                parsed = JSON.parse(jsonMatch[0]);
            } catch (e) {
                return { ok: false, error: `JSON parse fail: ${e instanceof Error ? e.message : String(e)}` };
            }

            return sanitizeExtractedWorkLog(parsed);
        } catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
            if (attempt < maxAttempts) {
                const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 10000);
                onRetry?.(attempt, delay);
                await sleep(delay);
                continue;
            }
        }
    }

    return { ok: false, error: `Gemini API selhalo: ${lastError}` };
}