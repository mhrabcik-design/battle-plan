import Dexie, { type Table, type Transaction } from 'dexie';
import { reconcileProjectIdentities } from './utils/projectIdentityReconciliation.ts';
import type {
    CapabilityPayload,
    EventBatchPayload,
    ProtocolEffect,
    ProtocolErrorCode,
    ProtocolRevision,
    ResponsePayload,
    ResultPayload,
    SnapshotPayload,
} from './services/agentProtocol/contracts.ts';

export interface SubTask {
    id: string;
    title: string;
    completed: boolean;
}

export interface Task {
    id?: number;
    /** Portable protocol identity. Numeric `id` remains the local Dexie key. */
    publicId?: string;
    title: string;
    description?: string;
    internalNotes?: string;
    type: 'task' | 'meeting' | 'note' | 'thought';
    duration?: number; // minutes left to do
    totalDuration?: number; // original estimated minutes
    date?: string; // start date ISO
    deadline?: string; // deadline ISO date
    startTime?: string; // HH:mm
    isAllDay?: boolean; // pokud true, zabírá celý den (bez startTime/duration)
    urgency: 1 | 2 | 3; // 1 low (bez urgentnosti), 2 normal (default), 3 high (urgentní)
    status: 'pending' | 'completed' | 'cancelled';
    subTasks?: SubTask[];
    progress?: number; // 0-100
    googleEventId?: string;
    source?: 'user' | 'agent'; // attribution: which surface produced this row
    agent_write_id?: string; // inbox AgentWrite.id (only present when source === 'agent')
    updatedAt: number;
    isDeleted?: boolean;
    createdAt: number;
}

export interface Setting {
    id: string;
    value: string;
    source?: 'user' | 'agent';
    agent_write_id?: string;
}

// === Work Logs (Pracovní činnosti) ===

/** 5 pastel preset barev pro projekty — nebudou řvát, ale budou odlišitelné. */
export type ProjectColor = 'slate' | 'indigo' | 'emerald' | 'amber' | 'rose';

/** Barva projektu — pro barevné odlišení v kalendáři. */
export interface Project {
    id?: number;
    /** Portable protocol identity. Numeric `id` remains the local Dexie key. */
    publicId?: string;
    name: string;       // unikátní (case-insensitive), např. "KB Plaza Liberec"
    aliases?: string[]; // dřívější/sloučené názvy; sdílí unikátní namespace s name
    color: ProjectColor;
    isActive: boolean;  // soft-delete — staré projekty se v pickeru nezobrazí, ale WorkLog záznamy zůstanou
    source?: 'user' | 'agent';
    agent_write_id?: string;
    updatedAt: number;
    createdAt: number;
}

/** Jeden záznam pracovní činnosti (diktovaný / manuální). */
export interface WorkLog {
    id?: number;
    /** Portable protocol identity. `syncId` remains the Drive sync identity. */
    publicId?: string;
    syncId?: string;        // stabilní identita pro slučování mezi zařízeními
    date: string;          // ISO date YYYY-MM-DD — datum konání práce (NE diktování)
    projectId: number;     // FK → Project.id
    projectName: string;   // denormalizovaný název (zůstane i když se projekt smaže/přejmenuje)
    people: string;        // volný text: "Pepa, Lukáš"
    hours: number;         // reportované hodiny; u batch hlasu člověkohodiny
    hoursPerPerson?: number;
    peopleCount?: number;
    calculationNote?: string;
    assumptions?: string[];
    extractionBatchId?: string;
    description?: string;  // co se dělalo
    source: 'voice' | 'manual' | 'agent'; // 'agent' added by agent write path (U4)
    agent_write_id?: string;
    updatedAt: number;
    createdAt: number;
}

// AgentInbox row: mirror of the inbox file in Dexie so the diagnostics
// surface can read pending writes via useLiveQuery without a Drive round-trip.
export interface AgentInboxRow {
    id: string;             // AgentWrite.id
    action: string;         // AgentWriteAction
    entity_type: 'task' | 'worklog' | 'project' | 'settings';
    entity_id?: number;      // Dexie row id once applied
    payload: unknown;        // normalized payload that was applied (or attempted)
    received_at: number;     // timestamp when bridge first read the row from the inbox file
    applied_at?: number;     // timestamp when applyWrite succeeded
    last_error?: string;     // populated on failure so the next poll can retry
}

export type AgentCommandLifecycle =
    | 'received'
    | 'awaiting_approval'
    | 'executing'
    | 'retry_scheduled'
    | 'applied'
    | 'rejected'
    | 'expired'
    | 'blocked'
    | 'stale';

export type AgentEffectState = 'none' | 'pending' | 'running' | 'retry_scheduled' | 'succeeded' | 'failed';
export type AgentProtocolEffectState = Exclude<AgentEffectState, 'none'>;

export interface AgentCommandReceiptHistoryEntry {
    id: string;
    receiptId: string;
    entryIndex: number;
    lifecycle: AgentCommandLifecycle;
    at: number;
    fencingToken: number;
    errorCode?: ProtocolErrorCode;
}

export interface AgentCommandReceiptRow {
    id: string;
    commandId: string;
    payloadDigest: `sha256:${string}`;
    producerId: string;
    receiverId: string;
    lifecycle: AgentCommandLifecycle;
    effectState: AgentEffectState;
    leaseOwner?: string;
    leaseExpiresAt?: number;
    retryAt?: number;
    fencingToken: number;
    attempts: number;
    result?: { entityPublicId?: string; revision?: ProtocolRevision; errorCode?: ProtocolErrorCode };
    historyCount: number;
    createdAt: number;
    updatedAt: number;
    retainUntil: number;
}

export interface AgentCommandConflictRow {
    id: string;
    receiptId: string;
    commandId: string;
    receiverId: string;
    originalDigest: `sha256:${string}`;
    conflictingDigest: `sha256:${string}`;
    lifecycle: 'blocked';
    errorCode: 'idempotency_conflict';
    createdAt: number;
    retainUntil: number;
}

export interface AgentEventStreamRow {
    streamId: string;
    producerId: string;
    nextSequence: string;
    updatedAt: number;
}

export interface AgentProtocolEventRow {
    id: string;
    eventId: string;
    streamId: string;
    producerId: string;
    sequence: string;
    eventType: EventBatchPayload['events'][number]['event_type'];
    entityKind: 'task' | 'project' | 'worklog';
    entityPublicId: string;
    revision: ProtocolRevision;
    payloadDigest: `sha256:${string}`;
    conflictHeads?: string[];
    occurredAt: string;
    actor: string;
    origin: EventBatchPayload['events'][number]['origin'];
    causeId: string;
    projection: EventBatchPayload['events'][number]['projection'];
    createdAt: number;
    publishedAt?: number;
}

interface AgentProtocolOutboxBase {
    id: string;
    messageId: string;
    payloadDigest?: `sha256:${string}`;
    commandReceiptId?: string;
    fencingToken?: number;
    status: 'pending' | 'publishing' | 'published' | 'retry_scheduled' | 'failed';
    attempts: number;
    nextAttemptAt?: number;
    createdAt: number;
    updatedAt: number;
}

export type AgentProtocolOutboxRow = AgentProtocolOutboxBase & (
    | { family: 'result'; payload: ResultPayload }
    | { family: 'event'; payload: EventBatchPayload }
    | { family: 'snapshot'; payload: SnapshotPayload }
    | { family: 'response'; payload: ResponsePayload }
    | { family: 'capability'; payload: CapabilityPayload }
);

export interface AgentProtocolEffectRow {
    id: string;
    commandReceiptId: string;
    kind: ProtocolEffect['kind'];
    state: AgentProtocolEffectState;
    attempts: number;
    fencingToken: number;
    nextAttemptAt?: number;
    lastErrorCode?: ProtocolErrorCode;
    createdAt: number;
    updatedAt: number;
}

export interface AgentConsumerStateRow {
    id: string;
    consumerId: string;
    streamId: string;
    lastSequence: string;
    gapExpected?: string;
    gapObserved?: string;
    requiresSnapshot: boolean;
    inactiveAfter: number;
    updatedAt: number;
}

export interface AgentSigningKeyRefRow {
    keyId: string;
    receiverId: string;
    pairingEpoch: number;
    privateKeyRef: string;
    status: 'active' | 'retired' | 'revoked';
    createdAt: number;
    updatedAt: number;
}

export interface AgentPairingKeyRow {
    id: string;
    workspaceId: string;
    producerId: string;
    receiverId: string;
    keyId: string;
    pairingEpoch: number;
    publicKey: string;
    fingerprint: string;
    status: 'active' | 'retired' | 'revoked';
    createdAt: number;
    revokedAt?: number;
    retainUntil: number;
}

export type AgentPersistenceStatus = 'unknown' | 'granted' | 'denied' | 'lost' | 'unavailable';

export interface AgentReceiverCapabilityRow {
    receiverId: string;
    enabled: boolean;
    status: 'unpaired' | 'ready' | 'disabled' | 'quarantined';
    persistenceStatus: AgentPersistenceStatus;
    persistenceCheckedAt?: number;
    createdAt?: number;
    updatedAt: number;
}

const createPortableId = (kind: 'task' | 'project' | 'worklog'): string => `${kind}_${crypto.randomUUID()}`;
const portableIdentityRepairTransactions = new WeakSet<Transaction>();
const completedPortableIdentityBackfills = new WeakSet<Transaction>();

async function backfillPortableIdentities(transaction: Transaction): Promise<void> {
    if (completedPortableIdentityBackfills.has(transaction)) return;

    const tasks = transaction.table<Task, number>('tasks');
    const projects = transaction.table<Project, number>('projects');
    const workLogs = transaction.table<WorkLog, number>('workLogs');

    const used = new Set<string>();
    const [taskRows, projectRows, workLogRows] = await Promise.all([
        tasks.toArray(),
        projects.toArray(),
        workLogs.toArray(),
    ]);
    const changedTasks: Task[] = [];
    const changedProjects: Project[] = [];
    const changedWorkLogs: WorkLog[] = [];
    for (const task of taskRows) {
        if (task.publicId && !used.has(task.publicId)) used.add(task.publicId);
        else {
            let publicId = createPortableId('task');
            while (used.has(publicId)) publicId = createPortableId('task');
            used.add(publicId);
            changedTasks.push({ ...task, publicId });
        }
    }

    for (const project of projectRows) {
        if (project.publicId && !used.has(project.publicId)) used.add(project.publicId);
        else {
            let publicId = createPortableId('project');
            while (used.has(publicId)) publicId = createPortableId('project');
            used.add(publicId);
            changedProjects.push({ ...project, publicId });
        }
    }

    for (const workLog of workLogRows) {
        let publicId = workLog.publicId;
        if (!publicId || used.has(publicId)) {
            publicId = createPortableId('worklog');
            while (used.has(publicId)) publicId = createPortableId('worklog');
        }
        used.add(publicId);
        const syncId = workLog.syncId ?? crypto.randomUUID();
        if (publicId !== workLog.publicId || syncId !== workLog.syncId) {
            changedWorkLogs.push({ ...workLog, publicId, syncId });
        }
    }
    portableIdentityRepairTransactions.add(transaction);
    try {
        await Promise.all([
            changedTasks.length ? tasks.bulkPut(changedTasks) : Promise.resolve(),
            changedProjects.length ? projects.bulkPut(changedProjects) : Promise.resolve(),
            changedWorkLogs.length ? workLogs.bulkPut(changedWorkLogs) : Promise.resolve(),
        ]);
        completedPortableIdentityBackfills.add(transaction);
    } finally {
        portableIdentityRepairTransactions.delete(transaction);
    }
}

export class BattlePlanDB extends Dexie {
    tasks!: Table<Task>;
    settings!: Table<Setting>;
    workLogs!: Table<WorkLog>;
    projects!: Table<Project>;
    agentInbox!: Table<AgentInboxRow>;
    agentCommandReceipts!: Table<AgentCommandReceiptRow, string>;
    agentCommandReceiptHistory!: Table<AgentCommandReceiptHistoryEntry, string>;
    agentCommandConflicts!: Table<AgentCommandConflictRow, string>;
    agentEventStreams!: Table<AgentEventStreamRow, string>;
    agentProtocolEvents!: Table<AgentProtocolEventRow, string>;
    agentProtocolOutbox!: Table<AgentProtocolOutboxRow, string>;
    agentProtocolEffects!: Table<AgentProtocolEffectRow, string>;
    agentConsumerStates!: Table<AgentConsumerStateRow, string>;
    agentSigningKeyRefs!: Table<AgentSigningKeyRefRow, string>;
    agentPairingKeys!: Table<AgentPairingKeyRow, string>;
    agentReceiverCapabilities!: Table<AgentReceiverCapabilityRow, string>;

    constructor(name = 'BattlePlanDB') {
        super(name);
        this.version(1).stores({
            tasks: '++id, type, date, urgency, status, createdAt',
            recordings: '++id, analyzed, createdAt'
        });
        this.version(2).stores({
            tasks: '++id, type, date, urgency, status, createdAt',
            recordings: '++id, analyzed, createdAt',
            settings: 'id'
        });
        this.version(4).stores({
            tasks: '++id, type, date, deadline, urgency, status, createdAt',
            settings: 'id'
        });
        this.version(5).stores({
            tasks: '++id, type, date, deadline, urgency, status, googleEventId, createdAt',
            recordings: '++id, analyzed, createdAt',
            settings: 'id'
        });
        this.version(6).stores({
            tasks: '++id, type, date, deadline, urgency, status, googleEventId, updatedAt, isDeleted, createdAt',
            recordings: '++id, analyzed, createdAt',
            settings: 'id'
        });
        this.version(7).stores({
            tasks: '++id, type, date, deadline, urgency, status, googleEventId, updatedAt, isDeleted, createdAt',
            recordings: '++id, analyzed, createdAt',
            settings: 'id'
        });
        this.version(8).stores({
            tasks: '++id, type, date, deadline, urgency, status, googleEventId, updatedAt, isDeleted, createdAt',
            recordings: '++id, analyzed, createdAt',
            settings: 'id',
            workLogs: '++id, date, projectId, hours, createdAt',
            projects: '++id, name, isActive, createdAt'
        });
        // v9: drop the unused recordings table; add the agentInbox mirror so
        // the diagnostics surface can read pending agent writes via
        // useLiveQuery. The other tables are unchanged from v8; existing rows
        // carry source undefined (optional) so no backfill is required.
        this.version(9).stores({
            tasks: '++id, type, date, deadline, urgency, status, googleEventId, updatedAt, isDeleted, createdAt',
            settings: 'id',
            workLogs: '++id, date, projectId, hours, createdAt',
            projects: '++id, name, isActive, createdAt',
            agentInbox: 'id, action, entity_type, applied_at, received_at'
        });
        // v10: one normalized project name is one durable identity. Repair
        // legacy/device-local duplicates and attach orphaned WorkLogs to the
        // reusable catalog row without deleting any work history.
        this.version(10).stores({
            tasks: '++id, type, date, deadline, urgency, status, googleEventId, updatedAt, isDeleted, createdAt',
            settings: 'id',
            workLogs: '++id, date, projectId, hours, createdAt',
            projects: '++id, name, isActive, createdAt',
            agentInbox: 'id, action, entity_type, applied_at, received_at'
        }).upgrade(async (transaction) => {
            const reconciliation = await reconcileProjectIdentities(
                transaction.table<Project, number>('projects'),
                transaction.table<WorkLog, number>('workLogs'),
            );
            if (reconciliation.projectIdRemaps.size === 0) return;

            const inbox = transaction.table<AgentInboxRow, string>('agentInbox');
            const pendingRows = (await inbox.toArray()).filter((row) => row.applied_at == null);
            const migratedRows = pendingRows.flatMap((row) => {
                if (!row.payload || typeof row.payload !== 'object') return [];
                const payload = { ...row.payload } as Record<string, unknown>;
                const field = row.entity_type === 'project' ? 'project_data' : 'worklog_data';
                const entity = payload[field];
                if (!entity || typeof entity !== 'object') return [];
                const data = { ...entity } as Record<string, unknown>;
                const idField = row.entity_type === 'project' ? 'id' : 'projectId';
                const currentId = data[idField];
                if (typeof currentId !== 'number') return [];
                const projectId = reconciliation.projectIdRemaps.get(currentId);
                if (projectId == null) return [];
                data[idField] = projectId;
                payload[field] = data;
                return [{ ...row, payload }];
            });
            if (migratedRows.length > 0) await inbox.bulkPut(migratedRows);
        });
        // v11: durable Agent Protocol v2 correctness primitives. Portable
        // identities augment local numeric keys; they never replace them.
        this.version(11).stores({
            tasks: '++id, publicId, type, date, deadline, urgency, status, googleEventId, updatedAt, isDeleted, createdAt',
            settings: 'id',
            workLogs: '++id, publicId, syncId, date, projectId, hours, createdAt',
            projects: '++id, publicId, name, isActive, createdAt',
            agentInbox: 'id, action, entity_type, applied_at, received_at',
            agentCommandReceipts: 'id, commandId, receiverId, lifecycle, leaseExpiresAt, retainUntil, updatedAt',
            agentCommandReceiptHistory: 'id, receiptId, entryIndex, lifecycle, at',
            agentCommandConflicts: 'id, commandId, receiverId, createdAt, retainUntil',
            agentEventStreams: 'streamId, producerId, updatedAt',
            agentProtocolEvents: 'id, eventId, streamId, producerId, entityKind, entityPublicId, createdAt, publishedAt',
            agentProtocolOutbox: 'id, family, messageId, commandReceiptId, status, nextAttemptAt, createdAt',
            agentProtocolEffects: 'id, commandReceiptId, kind, state, nextAttemptAt, updatedAt',
            agentConsumerStates: 'id, consumerId, streamId, requiresSnapshot, inactiveAfter, updatedAt',
            agentSigningKeyRefs: 'keyId, receiverId, pairingEpoch, status, updatedAt',
            agentPairingKeys: 'id, workspaceId, producerId, receiverId, keyId, pairingEpoch, status, retainUntil',
            agentReceiverCapabilities: 'receiverId, enabled, status, persistenceStatus, updatedAt',
        }).upgrade(backfillPortableIdentities);

        // v12 is an explicit repair stage for direct v11 upgrades. A database
        // can already report v11 while still containing duplicate public IDs,
        // so keep these indexes non-unique until the repair transaction ends.
        this.version(12).stores({
            tasks: '++id, publicId, type, date, deadline, urgency, status, googleEventId, updatedAt, isDeleted, createdAt',
            settings: 'id',
            workLogs: '++id, publicId, syncId, date, projectId, hours, createdAt',
            projects: '++id, publicId, name, isActive, createdAt',
            agentInbox: 'id, action, entity_type, applied_at, received_at',
            agentCommandReceipts: 'id, commandId, receiverId, lifecycle, leaseExpiresAt, retainUntil, updatedAt',
            agentCommandReceiptHistory: 'id, receiptId, entryIndex, lifecycle, at',
            agentCommandConflicts: 'id, commandId, receiverId, createdAt, retainUntil',
            agentEventStreams: 'streamId, producerId, updatedAt',
            agentProtocolEvents: 'id, eventId, streamId, producerId, entityKind, entityPublicId, createdAt, publishedAt',
            agentProtocolOutbox: 'id, family, messageId, commandReceiptId, status, nextAttemptAt, createdAt',
            agentProtocolEffects: 'id, commandReceiptId, kind, state, nextAttemptAt, updatedAt',
            agentConsumerStates: 'id, consumerId, streamId, requiresSnapshot, inactiveAfter, updatedAt',
            agentSigningKeyRefs: 'keyId, receiverId, pairingEpoch, status, updatedAt',
            agentPairingKeys: 'id, workspaceId, producerId, receiverId, keyId, pairingEpoch, status, retainUntil',
            agentReceiverCapabilities: 'receiverId, enabled, status, persistenceStatus, updatedAt',
        }).upgrade(backfillPortableIdentities);

        // v13 remains non-unique for compatibility with databases created by
        // a previous v13 schema. Some databases can report v12/v13 while
        // rows are still missing portable identities, so a later version must
        // repair the data before uniqueness is enforced again.
        this.version(13).stores({});

        // v14 is the compatibility repair boundary for already-created v12
        // and v13 databases. Keep indexes non-unique for the whole repair
        // transaction so duplicate and missing identities can be replaced.
        this.version(14).stores({}).upgrade(backfillPortableIdentities);

        // v15 creates the unique indexes only after the v14 repair transaction
        // has succeeded for every supported upgrade path.
        this.version(15).stores({
            tasks: '++id, &publicId, type, date, deadline, urgency, status, googleEventId, updatedAt, isDeleted, createdAt',
            workLogs: '++id, &publicId, syncId, date, projectId, hours, createdAt',
            projects: '++id, &publicId, name, isActive, createdAt',
        });

        // Keep identities present and immutable until all mutation paths share
        // the centralized domain-command transaction boundary.
        this.tasks.hook('creating', (_primaryKey, task) => {
            task.publicId ??= createPortableId('task');
        });
        this.tasks.hook('updating', (changes, _primaryKey, task) => {
            if (Dexie.currentTransaction && portableIdentityRepairTransactions.has(Dexie.currentTransaction)) return;
            if (!task.publicId) return { publicId: createPortableId('task') };
            if ('publicId' in changes && changes.publicId !== task.publicId) return { publicId: task.publicId };
        });
        this.projects.hook('creating', (_primaryKey, project) => {
            project.publicId ??= createPortableId('project');
        });
        this.projects.hook('updating', (changes, _primaryKey, project) => {
            if (Dexie.currentTransaction && portableIdentityRepairTransactions.has(Dexie.currentTransaction)) return;
            if (!project.publicId) return { publicId: createPortableId('project') };
            if ('publicId' in changes && changes.publicId !== project.publicId) return { publicId: project.publicId };
        });
        this.workLogs.hook('creating', (_primaryKey, workLog) => {
            workLog.publicId ??= createPortableId('worklog');
            workLog.syncId ??= crypto.randomUUID();
        });
        this.workLogs.hook('updating', (changes, _primaryKey, workLog) => {
            if (Dexie.currentTransaction && portableIdentityRepairTransactions.has(Dexie.currentTransaction)) return;
            const protectedChanges: Partial<WorkLog> = {};
            if (!workLog.publicId) protectedChanges.publicId = createPortableId('worklog');
            else if ('publicId' in changes && changes.publicId !== workLog.publicId) protectedChanges.publicId = workLog.publicId;
            if (!workLog.syncId) protectedChanges.syncId = crypto.randomUUID();
            else if ('syncId' in changes && changes.syncId !== workLog.syncId) protectedChanges.syncId = workLog.syncId;
            return Object.keys(protectedChanges).length ? protectedChanges : undefined;
        });
    }
}

export const db = new BattlePlanDB();
