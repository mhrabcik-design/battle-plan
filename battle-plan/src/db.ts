import Dexie, { type Table } from 'dexie';

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
    updatedAt: number;
    isDeleted?: boolean;
    createdAt: number;
}

export interface Recording {
    id?: number;
    blob: Blob;
    transcript?: string;
    analyzed: boolean;
    createdAt: number;
}

export interface Setting {
    id: string;
    value: string;
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
    source: 'voice' | 'manual';
    updatedAt: number;
    createdAt: number;
}

export class BattlePlanDB extends Dexie {
    tasks!: Table<Task>;
    recordings!: Table<Recording>;
    settings!: Table<Setting>;
    workLogs!: Table<WorkLog>;
    projects!: Table<Project>;

    constructor() {
        super('BattlePlanDB');
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
            recordings: '++id, analyzed, createdAt',
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
    }
}



export const db = new BattlePlanDB();
