import type { UnifiedTask } from '../types';

export type CalendarInterval = {
  id: string;
  startMinute: number;
  endMinute: number;
};

export type CalendarLayoutItem = CalendarInterval & {
  column: number;
  columnCount: number;
  visible: boolean;
  hiddenCount: number;
};

const DAY_START = 7 * 60;
const DAY_END = 19 * 60;

const parseTime = (value?: string) => {
  if (!value) return DAY_START;
  const [hour, minute] = value.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return DAY_START;
  return hour * 60 + minute;
};

export function getWeeklyVisualInterval(task: UnifiedTask): CalendarInterval {
  const duration = Math.max(0, task.duration || 60);
  const semanticMinute = parseTime(task.startTime);
  const startMinute = task.type === 'task' ? semanticMinute - duration : semanticMinute;
  return {
    id: task.isGoogleTask ? `g-${task.googleId}` : `l-${task.id}`,
    startMinute: Math.max(DAY_START, Math.min(DAY_END, startMinute)),
    endMinute: Math.max(DAY_START, Math.min(DAY_END, startMinute + duration)),
  };
}

export function getCalendarDensity(height: number): 'compact' | 'standard' | 'comfortable' {
  if (height < 48) return 'compact';
  if (height < 72) return 'standard';
  return 'comfortable';
}

export function layoutCalendarIntervals(
  intervals: readonly CalendarInterval[],
  availableWidth: number,
  minimumColumnWidth = 56,
  gap = 4,
): CalendarLayoutItem[] {
  const sorted = [...intervals].sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.id.localeCompare(b.id));
  const output: CalendarLayoutItem[] = [];
  let group: Array<CalendarInterval & { column: number }> = [];
  let active: Array<CalendarInterval & { column: number }> = [];

  const flush = () => {
    if (!group.length) return;
    const columnCount = Math.max(...group.map(item => item.column)) + 1;
    const visibleColumns = Math.max(1, Math.min(columnCount, Math.floor((availableWidth + gap) / (minimumColumnWidth + gap))));
    const hiddenCount = group.filter(item => item.column >= visibleColumns).length;
    let indicatorAssigned = false;
    for (const item of group) {
      const visible = item.column < visibleColumns;
      output.push({
        ...item,
        columnCount: visibleColumns,
        visible,
        hiddenCount: visible && !indicatorAssigned && hiddenCount > 0 ? hiddenCount : 0,
      });
      if (visible && !indicatorAssigned) indicatorAssigned = true;
    }
    group = [];
    active = [];
  };

  for (const interval of sorted) {
    active = active.filter(item => item.endMinute > interval.startMinute);
    if (group.length && active.length === 0) flush();
    const used = new Set(active.map(item => item.column));
    let column = 0;
    while (used.has(column)) column += 1;
    const placed = { ...interval, column };
    group.push(placed);
    active.push(placed);
  }
  flush();

  const byId = new Map(output.map(item => [item.id, item]));
  return intervals.map(item => byId.get(item.id)!).filter(Boolean);
}
