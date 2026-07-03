import type { Task } from './db';

export type ViewMode = 'battle' | 'week' | 'tasks' | 'meetings' | 'thoughts' | 'worklogs' | 'suggestions' | 'debug';

export type UnifiedTask = Task & {
    isGoogleTask?: boolean;
    googleListId?: string;
    googleId?: string;
};

export type GoogleAuthState = 'SIGNED_IN' | 'REFRESH_PENDING' | 'OFFLINE_AUTH' | 'SIGNED_OUT';

export interface GoogleAuthStatus {
    state: GoogleAuthState;
    accessToken: string | null;
}

export interface GoogleTaskList {
    id: string;
    title?: string;
}

export interface GoogleTaskRaw {
    id: string;
    title: string;
    notes?: string;
    status?: string;
    due?: string;
    updated: string;
}

/** Pohled v záložce Pracovní činnosti. */
export type WorkLogsView = 'calendar' | 'table';
