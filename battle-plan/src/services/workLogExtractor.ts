/* eslint-disable @typescript-eslint/no-explicit-any */
import { db, type WorkLog, type Project } from '../db.ts';
import {
    fetchWithTimeout,
    getErrorMessage,
    getRetryDelay,
    isRetryableFetchError,
    prepareGeminiAudio,
    sleep,
} from './audioAiPipeline.ts';
import {
    calculatePersonHours,
    createWorkLogProposal,
    dateRegex,
    hasExplainedPersonHours,
    normalizePeopleList,
    toIsoDate,
} from '../utils/workLogBatch.ts';
import { createWorkLogSyncId } from '../utils/workLogSyncIdentity.ts';

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
Z diktovaného textu (v češtině) extrahuj pracovní činnosti do JSON.

{
  "entries": [
    {
      "projectName": string,
      "people": string[],
      "hoursPerPerson": number,
      "totalHours": number,
      "description": string,
      "date": string,
      "calculationNote": string
    }
  ],
  "assumptions": string[],
  "needsConfirmation": boolean,
  "confirmationReasons": string[]
}

Pravidla:
- Dnes je {{TODAY_ISO}} ({{TODAY_LABEL}}). Relativní data počítej vždy proti tomuto datu.
- Pokud uživatel řekne "včera" → date = včerejší den
- Pokud uživatel řekne "dneska" nebo "dnes" → date = dnešní den
- Pokud řekne konkrétní datum ("15. června") → převeď na YYYY-MM-DD
- "minulý týden" znamená pondělí až pátek minulého týdne, pokud uživatel výslovně nezmíní víkend.
- "každý den" v kontextu práce znamená každý pracovní den v aktivním období.
- "ve středu", "v pátek" apod. uvnitř období upravuje jen tento den.
- Dodatečné fráze "teď jsem si vzpomněl", "ještě", "vlastně", "oprava" jsou korekce předchozího rozsahu, ne samostatná nesouvisející práce.
- Pokud zmíní víc lidí: "Pepa, Lukáš a Tom" → ["Pepa", "Lukáš", "Tom"]
- "já" mapuj na "Martin", pokud není z kontextu jasné jiné jméno.
- Vztah bez jména zachovej smysluplně: "Sergej a jeho brácha" → ["Sergej", "Sergejův bratr"].
- Neznámé počty lidí pojmenuj stabilně v rámci diktátu: "dva lidi" → ["Pracovník 1", "Pracovník 2"].
- "ještě jeden člověk navíc" přidá "Pracovník 1" pouze k dotčenému dni nebo rozsahu.
- Pokud nezmíní projekt: projectName = ""
- Pokud nezmíní lidi ani počet: people = [] a needsConfirmation = true
- Pokud nezmíní hodiny: uhodni jen z jasného kontextu (např. "celý den" = 8), jinak needsConfirmation = true
- Pokud nezmíní co dělali: description = ""
- totalHours jsou člověkohodiny: počet lidí × hoursPerPerson. Např. 3 lidé × 10 h = 30.
- calculationNote vždy vysvětli stručně česky, např. "3 lidé × 10 h = 30 h".
- Schůzka/jednání nemá navyšovat práci, pokud uživatel jasně neříká, že šlo o odpracovanou činnost.

Příklad vstupu: "Minulý týden na Plaza jsme byli každý den já, Sergej a jeho brácha. 10 hodin denně. Teď jsem si vzpomněl, ve středu tam byl ještě jeden člověk navíc."
Příklad výstupu: {
  "entries": [
    { "projectName": "Plaza", "people": ["Martin", "Sergej", "Sergejův bratr"], "hoursPerPerson": 10, "totalHours": 30, "description": "", "date": "2026-06-22", "calculationNote": "3 lidé × 10 h = 30 h" },
    { "projectName": "Plaza", "people": ["Martin", "Sergej", "Sergejův bratr"], "hoursPerPerson": 10, "totalHours": 30, "description": "", "date": "2026-06-23", "calculationNote": "3 lidé × 10 h = 30 h" },
    { "projectName": "Plaza", "people": ["Martin", "Sergej", "Sergejův bratr", "Pracovník 1"], "hoursPerPerson": 10, "totalHours": 40, "description": "", "date": "2026-06-24", "calculationNote": "4 lidé × 10 h = 40 h" },
    { "projectName": "Plaza", "people": ["Martin", "Sergej", "Sergejův bratr"], "hoursPerPerson": 10, "totalHours": 30, "description": "", "date": "2026-06-25", "calculationNote": "3 lidé × 10 h = 30 h" },
    { "projectName": "Plaza", "people": ["Martin", "Sergej", "Sergejův bratr"], "hoursPerPerson": 10, "totalHours": 30, "description": "", "date": "2026-06-26", "calculationNote": "3 lidé × 10 h = 30 h" }
  ],
  "assumptions": ["Minulý týden byl vyložen jako pondělí až pátek.", "Hodiny jsou počítány jako člověkohodiny."],
  "needsConfirmation": false,
  "confirmationReasons": []
}

Vrať POUZE čistý JSON bez markdownu.
`.trim();

/** Výsledek extrakce — buď ready k uložení, nebo potřebuje doplnit projekt, nebo chyba. */
export type WorkLogExtractionResult =
    | { ok: true; data: ExtractedWorkLogBatch }
    | { ok: false; error: string };

/** Jeden návrh WorkLogu z hlasové extrakce (ještě bez projectId). */
export interface ExtractedWorkLog {
    projectName: string;
    people: string;
    hours: number;
    hoursPerPerson?: number;
    peopleCount?: number;
    calculationNote?: string;
    assumptions?: string[];
    description?: string;
    date: string;
}

/** Batch návrh z hlasové extrakce. */
export interface ExtractedWorkLogBatch {
    entries: ExtractedWorkLog[];
    assumptions: string[];
    needsConfirmation: boolean;
    confirmationReasons: string[];
}

export const createEmptyWorkLogBatch = (): ExtractedWorkLogBatch => ({
    entries: [],
    assumptions: [],
    needsConfirmation: false,
    confirmationReasons: [],
});

/** Pokusí se najít projekt v DB — case-insensitive match, přesná shoda, contains. */
export function findProjectByName(name: string, allProjects: Project[]): Project | null {
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

    const entriesRaw = Array.isArray(raw.entries) ? raw.entries : [raw];
    const assumptions = Array.isArray(raw.assumptions)
        ? raw.assumptions.map((a: unknown) => String(a).trim()).filter(Boolean)
        : [];
    const confirmationReasons = Array.isArray(raw.confirmationReasons)
        ? raw.confirmationReasons.map((r: unknown) => String(r).trim()).filter(Boolean)
        : [];
    const entries: ExtractedWorkLog[] = [];
    let needsConfirmation = Boolean(raw.needsConfirmation);

    for (const entryRaw of entriesRaw) {
        if (!entryRaw || typeof entryRaw !== 'object') continue;
        const people = normalizePeopleList(entryRaw.people);
        const entryAssumptions: string[] = [];
        const hoursPerPerson = Number(entryRaw.hoursPerPerson);
        const totalHoursRaw = Number(entryRaw.totalHours ?? entryRaw.hours);
        const hasHoursPerPerson = !Number.isNaN(hoursPerPerson) && hoursPerPerson > 0;
        const totalHours = !Number.isNaN(totalHoursRaw) && totalHoursRaw > 0
            ? totalHoursRaw
            : hasHoursPerPerson
                ? calculatePersonHours(Math.max(people.length, 1), hoursPerPerson)
                : NaN;

        if (Number.isNaN(totalHours) || totalHours <= 0) {
            return { ok: false, error: 'Neplatné hodiny (musí být větší než 0)' };
        }

        if (!hasExplainedPersonHours(totalHours, people.length, hasHoursPerPerson ? hoursPerPerson : undefined)) {
            return { ok: false, error: 'Člověkohodiny nad 24 musí mít počet lidí a hodiny na osobu' };
        }

        let date = typeof entryRaw.date === 'string' ? entryRaw.date.trim() : '';
        if (!dateRegex.test(date)) {
            date = '';
            entryAssumptions.push('AI neurčilo platné datum práce. Vyber datum ručně.');
            confirmationReasons.push('Některý řádek nemá platné datum práce.');
            needsConfirmation = true;
        }

        if (people.length === 0) {
            entryAssumptions.push('AI neurčilo lidi. Doplň alespoň jednoho člověka.');
            confirmationReasons.push('Některý řádek nemá vyplněné lidi.');
            needsConfirmation = true;
        }

        const proposal = createWorkLogProposal({
            projectName: typeof entryRaw.projectName === 'string' ? entryRaw.projectName : '',
            people,
            hoursPerPerson: hasHoursPerPerson ? hoursPerPerson : undefined,
            totalHours,
            description: typeof entryRaw.description === 'string' ? entryRaw.description : '',
            date,
            assumptions: entryAssumptions,
            calculationNote: typeof entryRaw.calculationNote === 'string' ? entryRaw.calculationNote : undefined,
        });

        entries.push(proposal);
    }

    if (entries.length === 0) {
        return { ok: false, error: 'AI nevrátilo žádný pracovní záznam' };
    }

    return {
        ok: true,
        data: {
            entries,
            assumptions,
            needsConfirmation: needsConfirmation || confirmationReasons.length > 0,
            confirmationReasons: Array.from(new Set(confirmationReasons)),
        },
    };
}

/**
 * Aplikuje extrahovaná data — najde projekt, uloží WorkLog.
 * Vrací buď vytvořený WorkLog, nebo potřebu ručního doplnění projektu, nebo chybu.
 */
export type ApplyResult =
    | { ok: true; workLog: WorkLog; workLogs: WorkLog[] }
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
        project = findProjectByName(extracted.projectName, activeProjects);
    }

    if (!project) {
        return { needsProject: true, extracted };
    }

    // 3. Ulož WorkLog
    const now = Date.now();
    const syncId = createWorkLogSyncId();
    const id = await db.workLogs.add({
        syncId,
        date: extracted.date,
        projectId: project.id!,
        projectName: project.name, // použijeme canonical name z DB
        people: extracted.people,
        hours: extracted.hours,
        hoursPerPerson: extracted.hoursPerPerson,
        peopleCount: extracted.peopleCount,
        calculationNote: extracted.calculationNote,
        assumptions: extracted.assumptions,
        description: extracted.description || undefined,
        source: 'voice',
        createdAt: now,
        updatedAt: now,
    });

    return {
        ok: true,
        workLog: {
            id: id as number,
            syncId,
            date: extracted.date,
            projectId: project.id!,
            projectName: project.name,
            people: extracted.people,
            hours: extracted.hours,
            hoursPerPerson: extracted.hoursPerPerson,
            peopleCount: extracted.peopleCount,
            calculationNote: extracted.calculationNote,
            assumptions: extracted.assumptions,
            description: extracted.description || undefined,
            source: 'voice',
            createdAt: now,
            updatedAt: now,
        },
        workLogs: [{
            id: id as number,
            syncId,
            date: extracted.date,
            projectId: project.id!,
            projectName: project.name,
            people: extracted.people,
            hours: extracted.hours,
            hoursPerPerson: extracted.hoursPerPerson,
            peopleCount: extracted.peopleCount,
            calculationNote: extracted.calculationNote,
            assumptions: extracted.assumptions,
            description: extracted.description || undefined,
            source: 'voice',
            createdAt: now,
            updatedAt: now,
        }],
    };
}

// === Audio processing (paralelní geminiService.processAudio, ale s WorkLog promptem) ===

const buildWorkLogSystemPrompt = (referenceDate = new Date()): string => {
    const todayIso = toIsoDate(referenceDate);
    const todayLabel = referenceDate.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return WORKLOG_SYSTEM_PROMPT
        .replaceAll('{{TODAY_ISO}}', todayIso)
        .replaceAll('{{TODAY_LABEL}}', todayLabel);
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

    const audio = await prepareGeminiAudio(blob);

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
                            { text: buildWorkLogSystemPrompt() },
                            { inline_data: { mime_type: audio.mimeType, data: audio.base64Data } },
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
                    const delay = getRetryDelay(attempt);
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
            lastError = getErrorMessage(e);
            if (attempt < maxAttempts && isRetryableFetchError(e)) {
                const delay = getRetryDelay(attempt);
                onRetry?.(attempt, delay);
                await sleep(delay);
                continue;
            }
            break;
        }
    }

    return { ok: false, error: `Gemini API selhalo: ${lastError}` };
}
