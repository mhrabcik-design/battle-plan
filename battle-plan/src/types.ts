import type { Task } from './db';

export type ViewMode = 'battle' | 'week' | 'tasks' | 'meetings' | 'thoughts';

export type UnifiedTask = Task & {
    isGoogleTask?: boolean;
    googleListId?: string;
    googleId?: string;
};

export interface GoogleAuthStatus {
    isSignedIn: boolean;
    accessToken: string | null;
}
