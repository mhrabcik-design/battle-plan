import { Cloud, CloudOff, RefreshCw } from 'lucide-react';
import type { SyncVisualState } from '../types';

export function syncIconFor(state: SyncVisualState): {
    Icon: React.ElementType;
    tone: string;
    spin: boolean;
} {
    if (state === 'ok') {
        return { Icon: Cloud, tone: 'text-emerald-400/80', spin: false };
    }
    if (state === 'pending') {
        return { Icon: RefreshCw, tone: 'text-amber-300/90', spin: true };
    }
    return { Icon: CloudOff, tone: 'text-red-400/90', spin: false };
}
