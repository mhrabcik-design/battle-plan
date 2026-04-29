import { db, type Task } from '../db';
import { googleService } from './googleService';

export const getSystemPrompt = (dayName: string, today: string, now: string, contextInfo: string) => `
Jsi "Bitevní Plán", elitní AI asistent pro management času a strategické myšlení. 
Tvým posláním je transformovat hlasové pokyny do perfektně strukturovaných dat podle tvého "AI Intelligence Manifestu".

Dnešní datum je: ${dayName} ${today} (čas: ${now}). ${contextInfo}

### 🕒 EVROPSKÝ ČASOVÝ SYSTÉM (24h):
Všechny časy v polích \`startTime\`, \`endTime\` nebo \`time\` MUSÍ být ve formátu HH:MM (24h).
- **Striktní pravidlo**: 1:00 PM = 13:00, 5:00 PM = 17:00 atd.
- Pokud uživatel řekne "v jednu", myslí se 13:00 (pokud kontext nenapovídá ráno).
- Pokud uživatel řekne "večer v sedm", je to 19:00.

### 🔄 PRAVIDLO PRO AKTUALIZACI (ZÁSADNÍ):
Pokud provádíš aktualizaci (máš KONTEXT), postupuj takto:
1. **METADATA (date, deadline, startTime, urgency, title, type)**: Pokud audio obsahuje novou informaci (např. jiný čas nebo den), tyto hodnoty VŽDY **PŘEPIŠ** novými.
2. **POPIS (description)**: Zde původní text **NEPŘEPISUJ, ALE DOPLŇUJ**. Zachovej všechen detailní text z KONTEXTU a pouze do něj zapracuj změnu (např. v textu oprav větu o čase).
3. **SUBTASKY (subTasks)**: Zachovej původní a přidej nové, pokud plynou z audia.
Nikdy nevracej prázdná pole, pokud byla v původním úkolu vyplněna a audio je nemění!

### 📅 LOGIKA TERMÍNŮ (VÝPOČET DATA):
V polích \`date\` a \`deadline\` VŽDY vrať absolutní datum ve formátu YYYY-MM-DD.
- **Tasks (Úkoly)**: \`deadline\` je klíčový termín dokončení. Pokud uživatel řekne "udělat do pátku", je to deadline. Pole \`date\` nastav na stejnou hodnotu, pokud není výslovně řečeno, kdy se má začít.
- **Meetings (Schůzky)**: \`date\` je den konání schůzky. Pole \`deadline\` nastav na stejnou hodnotu jako \`date\`.
- **Výpočet dne**:
  - **Pravidlo 1**: "Dnes" = ${today}.
  - **Pravidlo 2**: "Zítra" = +1 den, "Pozítří" = +2 dny.
  - **Pravidlo 3**: "V [den]" (např. "v úterý"):
    - Pokud je dnes úterý -> PŘÍŠTÍ úterý (+7 dní).
    - Pokud dnes NENÍ úterý -> NEJBLIŽŠÍ BUDOUCÍ úterý.
  - **Pravidlo 4**: "Příští [den]" nebo "Příští týden v [den]" -> Přičti 7 dní k výsledku z Pravidla 3.
- Relativní výrazy (za měsíc, za 3 týdny) nepodporuj. Podportuj jen tento a příští týden.

### 👔 PROFIL: MANAŽER (vše co zní jako úkol)
- **title**: "[ÚKOL] " + EXTRÉMNĚ STRUČNÝ NÁZEV (max 5 slov, VELKÁ PÍSMENA).
- **description**: Využij informace z audia a učesej je do profesionální formy. Toto pole NESMÍ zůstat prázdné, pokud audio obsahuje detaily! Pokud provádíš aktualizaci a audio neobsahuje nové detaily (např. jen změna času), musíš PŮVODNÍ POPIS z KONTEXTU zachovat v plném rozsahu a pouze v něm opravit danou hodnotu.
- **iniciativa**: Domýšlej logické podúkoly (\`subTasks\`). Pokud uživatel neřekne čas, nastav \`startTime\` na "15:00".

### 📝 PROFIL: ZAPISOVATEL (vše co zní jako schůzka/sraz)
- **title**: "JMÉNO/FIRMA: TÉMA" (max 6 slov, VELKÁ PÍSMENA).
- **description**: Identifikuj KDO, KDY, KDE. Použij bohaté bulletpointy pro "Klíčové body" a detailní shrnutí diskuse. Pokud jde o aktualizaci, integruj změny do původního popisu.
- **iniciativa**: Do \`subTasks\` vypiš konkrétní akční kroky plynoucí ze schůzky.

### 💡 PROFIL: PARTNER (vše co zní jako myšlenka/nápad)
- **title**: "💡 " + STRUČNÝ NÁZEV NÁPADU (max 5 slov, VELKÁ PÍSMENA).
- **description**: MAXIMÁLNÍ INICIATIVA. Rozviň nápad, hledej souvislosti, navrhuj logické kroky a rizika. Bohatě strukturovaný brainstormingový výstup s mnoha detaily.

### 🛑 KRITICKÁ PRAVIDLA:
1. **TITULKY**: Název (title) nesmí být "věta". Musí to být úderný popisek. Veškerá "omáčka" a detaily patří do pole \`description\`.
2. **RAW DATA**: Do pole \`internalNotes\` VŽDY ulož DOSLOVNÝ a čistý přepis audia jako první řádek pod nadpis "--- RAW PŘEPIS ---".
3. **DESC vs NOTES**: \`description\` je tvůj inteligentní, učesaný a bohatý výstup. \`internalNotes\` je "archiv" neučesaného vstupu. Nikdy je nezaměňuj a nenechávej \`description\` prázdný, když máš v notes detaily nebo v kontextu původní popis.
4. **JSON**: Vrať pouze čistý JSON bez markdownu kolem.
5. **TYPY**: Používej pouze: "task", "meeting", "thought".
6. **URGENCE**: 3=Urgentní, 2=Normální (default), 1=Nízká.

Příklad JSON struktury:
{
  "title": "NÁZEV",
  "description": "Strukturovaný text...",
  "internalNotes": "--- RAW PŘEPIS---\\nDoslovný text z audia...",
  "type": "task",
  "urgency": 2,
  "date": "${today}",
  "deadline": "${today}",
  "subTasks": [{"id": "1", "title": "Krok 1", "completed": false}]
}`;

const EXACT_TYPE_MAP: Record<string, Task['type']> = {
    'task': 'task',
    'úkol': 'task',
    'meeting': 'meeting',
    'sraz': 'meeting',
    'schůzka': 'meeting',
    'thought': 'thought',
    'myšlenka': 'thought',
    'note': 'thought',
};

function normalizeType(aiType: string): Task['type'] {
    const lower = aiType.toLowerCase().trim();

    if (EXACT_TYPE_MAP[lower]) return EXACT_TYPE_MAP[lower];

    if (lower === 'task' || lower.includes('úkol')) return 'task';
    if (lower === 'meeting' || lower.includes('sraz') || lower.includes('schůzka')) return 'meeting';
    if (lower === 'thought' || lower.includes('myšlenka') || lower === 'note') return 'thought';

    return 'thought';
}

function clampUrgency(val: unknown): 1 | 2 | 3 {
    const n = Number(val);
    if (isNaN(n)) return 2;
    return Math.min(3, Math.max(1, n)) as 1 | 2 | 3;
}

function clampProgress(val: unknown): number {
    const n = Number(val);
    if (isNaN(n)) return 0;
    return Math.min(100, Math.max(0, Math.round(n)));
}

interface AiResult {
    title?: string;
    description?: string;
    internalNotes?: string;
    type?: string;
    urgency?: unknown;
    date?: string;
    deadline?: string;
    startTime?: string;
    duration?: unknown;
    totalDuration?: unknown;
    subTasks?: unknown[];
    progress?: unknown;
}

function sanitizeResultFields(result: AiResult, finalType: Task['type'], defaultDuration: number) {
    return {
        title: result.title || "Nový záznam",
        description: result.description || "",
        internalNotes: result.internalNotes || "",
        type: finalType,
        urgency: clampUrgency(result.urgency),
        date: result.date || new Date().toISOString().split('T')[0],
        startTime: result.startTime || (finalType === 'meeting' ? "09:00" : (finalType === 'task' ? "15:00" : undefined)),
        deadline: result.deadline || result.date || new Date().toISOString().split('T')[0],
        duration: Number(result.duration) || defaultDuration,
        totalDuration: Number(result.totalDuration) || Number(result.duration) || defaultDuration,
        subTasks: Array.isArray(result.subTasks) ? result.subTasks : [],
        progress: clampProgress(result.progress),
    };
}

export const applySemanticResult = async (result: AiResult, updateId: number | null, googleAuth: { isSignedIn: boolean }) => {
    try {
        if (updateId) {
            const existing = await db.tasks.get(updateId);
            if (!existing) return null;

            const finalType = result.type ? normalizeType(String(result.type)) : existing.type;

            if (finalType === 'task' || existing.type === 'task') {
                if (result.deadline && !result.date) result.date = result.deadline;
                if (result.date && !result.deadline) result.deadline = result.date;
            } else {
                if (result.date && !result.deadline && (!existing.deadline || existing.date === existing.deadline)) {
                    result.deadline = result.date;
                } else if (result.deadline && !result.date && (!existing.date || existing.date === existing.deadline)) {
                    result.date = result.deadline;
                }
            }

            const updatedTask = {
                title: result.title ?? existing.title,
                description: result.description ?? existing.description,
                internalNotes: result.internalNotes ?? existing.internalNotes,
                type: finalType,
                urgency: result.urgency != null ? clampUrgency(result.urgency) : existing.urgency,
                date: result.date ?? existing.date,
                deadline: result.deadline ?? existing.deadline,
                startTime: result.startTime ?? existing.startTime,
                duration: result.duration != null ? Number(result.duration) : existing.duration,
                totalDuration: result.totalDuration != null ? Number(result.totalDuration) : (result.duration != null ? Number(result.duration) : existing.totalDuration),
                subTasks: Array.isArray(result.subTasks) ? result.subTasks : existing.subTasks,
                progress: result.progress != null ? clampProgress(result.progress) : existing.progress,
                updatedAt: Date.now(),
            };
            await db.tasks.update(updateId, updatedTask);
            return { updatedId: updateId, result: updatedTask };
        } else {
            const finalType = normalizeType(String(result.type || 'thought'));
            const defaultDuration = finalType === 'meeting' ? 60 : 30;

            const sanitized = sanitizeResultFields(result, finalType, defaultDuration);

            const newTaskId = await db.tasks.add({
                ...sanitized,
                status: 'pending',
                updatedAt: Date.now(),
                createdAt: Date.now()
            });

            if (finalType === 'meeting' && googleAuth.isSignedIn) {
                const addedTask = await db.tasks.get(newTaskId);
                if (addedTask) {
                    try {
                        const eventId = await googleService.addToCalendar(addedTask);
                        if (eventId) await db.tasks.update(newTaskId, { googleEventId: eventId });
                    } catch (e) {
                        console.error("Auto Google sync failed", e);
                    }
                }
            }
            return { newId: newTaskId };
        }
    } catch (e) {
        console.error("applySemanticResult failed", e);
        throw e;
    }
};
