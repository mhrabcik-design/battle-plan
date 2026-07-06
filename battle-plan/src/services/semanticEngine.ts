import { db, type SubTask, type Task } from '../db.ts';
import { googleService } from './googleService.ts';
import type { GoogleAuthStatus } from '../types.ts';
import { hasUsableAuth } from '../types.ts';
import { EXACT_TYPE_MAP, normalizeType, clampUrgency, clampIsAllDay, clampProgress } from './taskNormalization.ts';
import type { AppContext } from './appContext.ts';
import { renderAppContextSection } from './appContext.ts';
export const getSystemPrompt = (dayName: string, today: string, now: string, contextInfo: string, appContext?: AppContext) => `
Jsi "Bitevní Plán", elitní AI asistent pro management času a strategické myšlení.
Tvým posláním je transformovat hlasové pokyny do perfektně strukturovaných dat podle tvého "AI Intelligence Manifestu".

Dnešní datum je: ${dayName} ${today} (čas: ${now}). ${contextInfo}

### 🕒 EVROPSKÝ ČASOVÝ SYSTÉM (24h):
Všechny časy v polích \`startTime\`, \`endTime\` nebo \`time\` MUSÍ být ve formátu HH:MM (24h).
- **Striktní pravidlo**: 1:00 PM = 13:00, 5:00 PM = 17:00 atd.
- Pokud uživatel řekne "v jednu", myslí se 13:00 (pokud kontext nenapovídá ráno).
- Pokud uživatel řekne "večer v sedm", je to 19:00.

### 🌞 CELODENNÍ ÚKOLY A SCHŮZKY (isAllDay):
- Pokud uživatel řekne "**na celý den**", "**celodenní**", "**celý den**", "**bez času**", "**kdykoliv během dne**", "**dopoledne**", "**odpoledne**", "**přes den**" → nastav \`isAllDay: true\`
- Při \`isAllDay: true\` NEVYPŁŇUJ \`startTime\` (nech prázdné nebo null) a \`duration\` nastav na výchozí (60 pro meeting, 30 pro task)
- Pokud uživatel výslovně neřekne "na celý den", nech \`isAllDay: false\` (výchozí)

### ⏱️ TRVÁNÍ ÚKOLU (duration):
- Pokud uživatel řekne "**2 hodiny**", "**hodina a půl**", "**30 minut**", "**90 minut**" → přepočítej na minuty a nastav \`duration\`
- Příklady: "2 hodiny" = 120, "hodina a půl" = 90, "půl hodiny" = 30, "čtvrthodinka" = 15, "2,5 hodiny" = 150
- Pokud není řečeno, použij výchozí: meeting = 60 min, task = 30 min

### 🔄 PRAVIDLO PRO AKTUALIZACI (ZÁSADNÍ):
Pokud provádíš aktualizaci (más KONTEXT), postupuj takto:
1. **METADATA (date, deadline, startTime, urgency, title, type, isAllDay, duration)**: Pokud audio obsahuje novou informaci (např. jiný čas nebo den), tyto hodnoty VŽDY **PŘEPIŠ** novými. Pokud audio říká "na celý den", nastav isAllDay: true i když v kontextu je startTime.
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
- **description**: MAXIMÁLNÍ INICIATIVA. Rozviň nápad, hledej souvislosti, navrhni logické kroky a rizika. Bohatě strukturovaný brainstormingový výstup s mnoha detaily.

4. **JSON**: Vrať pouze čistý JSON bez markdownu kolem.
${appContext ? '\n' + renderAppContextSection(appContext) + '\n' : ''}
5. **TYPY**: Používej pouze: "task", "meeting", "thought".


### ⚙️ SANITIZAČNÍ PRAVIDLA (tato pravidla dodržuj dříve než vrátíš výstup):
7. **Type**: \`task\`, \`meeting\`, \`thought\` pouze. České synonymy mapují na stejný typ: \`úkol\` → \`task\`, \`sraz\`/\`schůzka\` → \`meeting\`, \`myšlenka\`/\`poznámka\`/\`note\` → \`thought\`. Cokoli jiného → \`thought\`.
8. **Urgency**: škála 1..3 s defaultem 2. 1 = Nízká, 2 = Normální, 3 = Urgentní. Pokud váháš, default 2.
9. **isAllDay**: true pokud uživatel řekl "na celý den" / "celodenní" / "bez času" / "celý den". Při \`isAllDay: true\` vyčisti \`startTime\` a \`duration\` na type-default.
10. **startTime default**: meeting → \`09:00\`, task → \`15:00\`. Použij pokud uživatel čas explicitne nezadal.
11. **progress**: celé číslo 0..100.

### 🛑 KRITICKÁ PRAVIDLA (TYPESAFE BACKSTOP):
Tyto kontroly provede aplikace po tvé odpovědi. Pokud je pravidlo v rozporu, tak to znamená, že jsi je porušil(a) a v dalším requestu to naprav.

### 🛑 KRITICKÁ PRAVIDLA:
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

// Type/clamp helpers and the EXACT_TYPE_MAP live in taskNormalization.ts.
// The high-level rules are documented in the system prompt's
// "## ⚙️ SANITIZAČNÍ PRAVIDLA" section above; these helpers round values
// the AI may have mis-typed but do not override correct values.

export interface NormalizeResult<T> {
  value: T;
  last_error?: string;
}

// Shared between the voice path and the agent path. The voice path
// (`applySemanticResult`) and the agent path (`agentBridge.applyTaskAction`)
// both call this; result invariants are identical so a Task written by
// either path round-trips through Dexie without drift.
export function normalizeEntity(
    result: unknown,
    action: 'create' | 'update' | 'complete' | 'delete',
    existing?: Task
): NormalizeResult<Partial<Task> & { urgency: 1 | 2 | 3; status: 'pending' | 'completed' | 'cancelled' }> {
    const obj = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const errors: string[] = [];

    const finalType = action === 'create'
        ? normalizeType(String(obj.type || 'thought'))
        : normalizeType(String(obj.type || existing?.type || 'thought'));
    if (action !== 'create' && obj.type && !EXACT_TYPE_MAP[String(obj.type).toLowerCase().trim()]) {
        errors.push(`unknown type "${String(obj.type)}" coerced to thought`);
    }
    out.type = finalType;

    out.urgency = action === 'create' || obj.urgency != null
        ? clampUrgency(obj.urgency)
        : existing?.urgency ?? 2;

    const isAllDay = obj.isAllDay != null
        ? clampIsAllDay(obj.isAllDay)
        : existing?.isAllDay ?? false;
    out.isAllDay = isAllDay;

    // Type-mirroring of date↔deadline.
    const r: Record<string, unknown> = { ...obj };
    if (finalType === 'task' || existing?.type === 'task') {
        if (r.deadline && !r.date) r.date = r.deadline;
        if (r.date && !r.deadline) r.deadline = r.date;
    } else {
        if (r.date && !r.deadline && (!existing?.deadline || existing.date === existing.deadline)) {
            r.deadline = r.date;
        } else if (r.deadline && !r.date && (!existing?.date || existing.date === existing.deadline)) {
            r.date = r.deadline;
        }
    }
    out.date = r.date ?? existing?.date;
    out.deadline = r.deadline ?? existing?.deadline;
    out.startTime = isAllDay ? undefined : (r.startTime ?? existing?.startTime ?? (finalType === 'meeting' ? '09:00' : (finalType === 'task' ? '15:00' : undefined)));
    out.duration = r.duration != null ? Number(r.duration) : existing?.duration;
    out.totalDuration = r.totalDuration != null ? Number(r.totalDuration) : (r.duration != null ? Number(r.duration) : existing?.totalDuration);
    out.title = r.title ?? existing?.title ?? 'Nový záznam';
    out.description = r.description ?? existing?.description ?? '';
    out.internalNotes = r.internalNotes ?? existing?.internalNotes ?? '';
    out.subTasks = Array.isArray(r.subTasks) ? (r.subTasks as SubTask[]) : existing?.subTasks ?? [];
    out.progress = r.progress != null ? clampProgress(r.progress) : existing?.progress;
    out.status = action === 'complete' ? 'completed' : (existing?.status ?? 'pending');

    return { value: out as Partial<Task> & { urgency: 1 | 2 | 3; status: 'pending' | 'completed' | 'cancelled' }, last_error: errors.length ? errors.join('; ') : undefined };
}

export const applySemanticResult = async (result: unknown, updateId: number | null, googleAuth: GoogleAuthStatus) => {
    try {
        if (updateId) {
            const existing = await db.tasks.get(updateId);
            if (!existing) return null;

            const norm = normalizeEntity(result, 'update', existing);
            const normValue = norm.value as Partial<Task>;
            const updated: Task = {
                id: existing.id,
                title: normValue.title ?? existing.title,
                description: normValue.description ?? existing.description,
                internalNotes: normValue.internalNotes ?? existing.internalNotes,
                type: normValue.type ?? existing.type,
                urgency: normValue.urgency ?? existing.urgency,
                status: normValue.status ?? existing.status,
                date: normValue.date ?? existing.date,
                deadline: normValue.deadline ?? existing.deadline,
                startTime: normValue.startTime ?? existing.startTime,
                duration: normValue.duration ?? existing.duration,
                totalDuration: normValue.totalDuration ?? existing.totalDuration,
                isAllDay: normValue.isAllDay ?? existing.isAllDay,
                subTasks: existing.subTasks ?? [],
                progress: normValue.progress ?? existing.progress,
                googleEventId: existing.googleEventId,
                source: existing.source,
                agent_write_id: existing.agent_write_id,
                isDeleted: existing.isDeleted,
                createdAt: existing.createdAt,
                updatedAt: Date.now(),
            };
            await db.tasks.update(updateId, updated as Partial<Task>);
            return { updatedId: updateId, result: updated };
        } else {
            const norm = normalizeEntity(result, 'create', undefined);
            const v = norm.value as Partial<Task> & { title: string; type: Task['type']; urgency: 1 | 2 | 3 };
            const newTaskId = await db.tasks.add({
                ...v,
                status: 'pending',
                updatedAt: Date.now(),
                createdAt: Date.now()
            });

            if (v.type === 'meeting' && hasUsableAuth(googleAuth)) {
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
