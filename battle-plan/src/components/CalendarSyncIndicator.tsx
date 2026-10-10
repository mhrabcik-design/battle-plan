import { CircleCheck, Clock3, CloudOff, RefreshCw, TriangleAlert } from 'lucide-react';
import type { CalendarIndicator } from '../utils/calendarSyncIndicator';

const icons = { neutral: CloudOff, pending: Clock3, syncing: RefreshCw, synced: CircleCheck, error: TriangleAlert };

export function CalendarSyncIndicator({ indicator, onOpenSettings }: {
    indicator: CalendarIndicator;
    onOpenSettings: () => void;
}) {
    const Icon = icons[indicator.state];
    return <button type="button" onClick={onOpenSettings}
        className="calendar-sync-indicator flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs transition-colors hover:bg-white/5"
        data-state={indicator.state} title={indicator.detail}
        aria-label={`Google Kalendář: ${indicator.label}${indicator.pending ? ` (${indicator.pending})` : ''}. ${indicator.detail} Otevřít nastavení synchronizace.`}>
        <Icon aria-hidden="true" className={`h-4 w-4 shrink-0 ${indicator.state === 'syncing' ? 'motion-safe:animate-spin' : ''}`} />
        <span className="min-w-0 leading-relaxed">
            <span className="block text-[10px] text-slate-500">Google Kalendář</span>
            <span>{indicator.label}{indicator.pending > 0 ? ` (${indicator.pending})` : ''}</span>
        </span>
    </button>;
}
