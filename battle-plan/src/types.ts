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

export type SyncVisualState = 'ok' | 'pending' | 'failed';

export function hasUsableAuth(auth: GoogleAuthStatus): boolean {
    return auth.state === 'SIGNED_IN' || auth.state === 'REFRESH_PENDING';
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

