import { db as defaultDb, type BattlePlanDB, type Task } from '../db.ts';
import { hasUsableAuth, type UnifiedTask } from '../types.ts';
import { drainGoogleExternalEffects } from './externalEffectOutbox.ts';
import type { CalendarWriteGuard } from './googleService.ts';
import { newTaskMutationContext, TaskMutationService, taskMutationTables } from './taskMutations.ts';

interface InvitationDependencies {
    db: BattlePlanDB;
    mutations: TaskMutationService;
    accountId: () => string | null;
    canExecute: () => boolean;
    drain: (ids: readonly string[]) => Promise<unknown>;
    getLink: (id: string, guard: CalendarWriteGuard) => Promise<string>;
    timeoutMs?: number;
}

const staleMessage = 'Schůzka se změnila. Otevřete její aktuální uloženou podobu a zkuste pozvání znovu.';
const pendingMessage = 'Synchronizace s Google Kalendářem ještě není dokončená. Zkontrolujte připojení a zkuste pozvání znovu.';
const revision = (task: Task) => task.protocolRevision?.revision_id ?? null;
function sameVersion(current: Task, expected: Task) {
    return current.publicId === expected.publicId && revision(current) === revision(expected)
        && (revision(expected) !== null || current.updatedAt === expected.updatedAt);
}
function validateMeeting(task: UnifiedTask) {
    if (task.id == null || !task.publicId || task.isGoogleTask || task.type !== 'meeting' || task.isDeleted || task.status === 'cancelled') {
        throw new Error('Pozvání vyžaduje uloženou, nezrušenou schůzku.');
    }
    const date = task.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
        || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
        throw new Error('Nejprve uložte platné datum schůzky.');
    }
    if (!task.isAllDay && (!task.startTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.startTime)
        || !Number.isFinite(task.duration) || (task.duration ?? 0) <= 0)) {
        throw new Error('Nejprve uložte čas začátku a kladnou délku schůzky.');
    }
}

async function defaultDependencies(): Promise<InvitationDependencies> {
    const { googleService } = await import('./googleService.ts');
    return {
        db: defaultDb,
        mutations: new TaskMutationService(defaultDb),
        accountId: () => googleService.getAccountId(),
        canExecute: () => hasUsableAuth(googleService.getAuthStatus())
            && (typeof navigator === 'undefined' || navigator.onLine !== false),
        drain: drainGoogleExternalEffects,
        getLink: (id, guard) => googleService.getCalendarEventLink(id, guard),
    };
}

/** Prepare one saved meeting; opening this link does not itself send invitations. */
export async function prepareCalendarInvitation(task: UnifiedTask, injected?: InvitationDependencies): Promise<string> {
    validateMeeting(task);
    const deps = injected ?? await defaultDependencies();
    const account = deps.accountId();
    const sessionMatches = () => Boolean(account && deps.accountId() === account && deps.canExecute());
    if (!sessionMatches()) throw new Error('Přihlaste se ke Google účtu a zkontrolujte připojení.');

    const prepared = await deps.db.transaction('rw', taskMutationTables(deps.db), async () => {
        const saved = await deps.db.tasks.get(task.id!);
        if (!saved || !sameVersion(saved, task)) throw new Error(staleMessage);
        validateMeeting(saved);
        if (!sessionMatches() || (saved.googleAccountId && saved.googleAccountId !== account)) {
            throw new Error('Přihlaste se ke Google účtu, se kterým je schůzka propojena.');
        }
        const result = await deps.mutations.queueEffects({ localId: saved.id, publicId: saved.publicId,
            expectedRevision: revision(saved), context: newTaskMutationContext('ui', undefined, account!),
            effects: [{ kind: 'calendar', operation: 'upsert' }] });
        if (result.status !== 'queued') throw new Error(staleMessage);
        const captured = (await deps.db.tasks.get(saved.id!))!;
        const targetEffects = await deps.db.agentProtocolEffects.bulkGet(result.effectIds);
        const lastSequence = Math.max(...targetEffects.map((effect) => effect?.sequence ?? -1));
        const predecessors = await deps.db.agentProtocolEffects.where('entityPublicId').equals(captured.publicId!).toArray();
        return { task: captured, targetIds: result.effectIds,
            drainIds: predecessors.filter((effect) => effect.sequence <= lastSequence).map((effect) => effect.id) };
    });
    const eventId = prepared.task.googleEventId ?? prepared.task.reservedGoogleEventId;
    if (!eventId) throw new Error('Schůzku se nepodařilo propojit s Google Kalendářem.');
    let active = true;
    const guard: CalendarWriteGuard = { isCurrent: async () => {
        if (!active || !sessionMatches()) return false;
        const current = await deps.db.tasks.get(task.id!);
        return Boolean(active && sessionMatches() && current && !current.isDeleted && current.status !== 'cancelled'
            && sameVersion(current, prepared.task) && current.googleAccountId === account
            && (current.googleEventId ?? current.reservedGoogleEventId) === eventId);
    } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            (async () => {
                if (!await guard.isCurrent()) throw new Error(staleMessage);
                await deps.drain(prepared.drainIds);
                if (!await guard.isCurrent()) throw new Error(staleMessage);
                const results = await deps.db.agentProtocolEffects.bulkGet(prepared.targetIds);
                if (results.some((effect) => effect?.state === 'failed')) {
                    throw new Error('Google odmítl synchronizaci schůzky. Opravte propojení a zkuste pozvání znovu.');
                }
                if (!results.length || results.some((effect) => effect?.state !== 'succeeded')) throw new Error(pendingMessage);
                const saved = await deps.db.tasks.get(task.id!);
                if (saved?.googleEventId !== eventId || !await guard.isCurrent()) throw new Error(staleMessage);
                const link = await deps.getLink(eventId, guard);
                if (!await guard.isCurrent()) throw new Error(staleMessage);
                return link;
            })(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => { active = false; reject(new Error(pendingMessage)); }, deps.timeoutMs ?? 20_000);
            }),
        ]);
    } finally {
        active = false;
        clearTimeout(timer);
    }
}
