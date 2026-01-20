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
    urgency: 1 | 2 | 3 | 4 | 5; // 1 lowest, 5 highest
    status: 'pending' | 'completed' | 'cancelled';
    subTasks?: SubTask[];
    progress?: number; // 0-100
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

export class BattlePlanDB extends Dexie {
    tasks!: Table<Task>;
    recordings!: Table<Recording>;
    settings!: Table<Setting>;

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
        this.version(3).stores({
            tasks: '++id, type, date, urgency, status, createdAt',
            recordings: '++id, analyzed, createdAt',
            settings: 'id'
        });
        this.version(4).stores({
            tasks: '++id, type, date, deadline, urgency, status, createdAt',
            recordings: '++id, analyzed, createdAt',
            settings: 'id'
        });
    }
}



export const db = new BattlePlanDB();
