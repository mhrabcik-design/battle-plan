import type { Task } from './db';

export type ViewMode = 'battle' | 'week' | 'tasks' | 'meetings' | 'thoughts' | 'worklogs' | 'suggestions' | 'debug';

export type UnifiedTask = Task & {
    isGoogleTask?: boolean;
    googleListId?: string;
    googleId?: string;
};

export interface GoogleAuthStatus {
    isSignedIn: boolean;
    accessToken: string | null;
}

/** Pohled v záložce Pracovní činnosti. */
export type WorkLogsView = 'calendar' | 'table';
