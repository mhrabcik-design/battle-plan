export type WorkLogsPanel = 'new-entry' | 'projects';

export function toggleWorkLogsPanel(
    current: WorkLogsPanel | null,
    requested: WorkLogsPanel,
): WorkLogsPanel | null {
    return current === requested ? null : requested;
}
