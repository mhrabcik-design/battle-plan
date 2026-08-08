import Dexie, { type Table } from 'dexie';
import { reconcileProjectIdentities } from './utils/projectIdentityReconciliation.ts';

export interface SubTask {
    id: string;
    title: string;
    completed: boolean;
}

export interface Task {
    id?: number;
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
    name: string;       // unikátní (case-insensitive), např. "KB Plaza Liberec"
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

export class BattlePlanDB extends Dexie {
    tasks!: Table<Task>;
    settings!: Table<Setting>;
    workLogs!: Table<WorkLog>;
    projects!: Table<Project>;
    agentInbox!: Table<AgentInboxRow>;

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
    }
}

export const db = new BattlePlanDB();
