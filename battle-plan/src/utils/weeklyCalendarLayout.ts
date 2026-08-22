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
  hiddenIds: string[];
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

const heapPush = <T,>(heap: T[], value: T, compare: (left: T, right: T) => number) => {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compare(heap[parent], heap[index]) <= 0) break;
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
};

const heapPop = <T,>(heap: T[], compare: (left: T, right: T) => number): T | undefined => {
  if (!heap.length) return undefined;
  const first = heap[0];
  const last = heap.pop()!;
  if (heap.length) {
    heap[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && compare(heap[left], heap[smallest]) < 0) smallest = left;
      if (right < heap.length && compare(heap[right], heap[smallest]) < 0) smallest = right;
      if (smallest === index) break;
      [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
      index = smallest;
    }
  }
  return first;
};

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
  let reusableColumns: number[] = [];
  let nextColumn = 0;
  const byEnd = (left: CalendarInterval & { column: number }, right: CalendarInterval & { column: number }) => left.endMinute - right.endMinute || left.column - right.column;
  const byColumn = (left: number, right: number) => left - right;

  const flush = () => {
    if (!group.length) return;
    const columnCount = nextColumn;
    const visibleColumns = Math.max(1, Math.min(columnCount, Math.floor((availableWidth + gap) / (minimumColumnWidth + gap))));
    const hiddenItems = group.filter(item => item.column >= visibleColumns);
    for (const item of group) {
      const visible = item.column < visibleColumns;
      const hiddenIds = visible
        ? hiddenItems.filter(hidden => hidden.startMinute < item.endMinute && hidden.endMinute > item.startMinute).map(hidden => hidden.id)
        : [];
      output.push({
        ...item,
        columnCount: visibleColumns,
        visible,
        hiddenCount: hiddenIds.length,
        hiddenIds,
      });
    }
    group = [];
    active = [];
    reusableColumns = [];
    nextColumn = 0;
  };

  for (const interval of sorted) {
    while (active.length && active[0].endMinute <= interval.startMinute) {
      const expired = heapPop(active, byEnd)!;
      heapPush(reusableColumns, expired.column, byColumn);
    }
    if (group.length && active.length === 0) flush();
    const column = heapPop(reusableColumns, byColumn) ?? nextColumn++;
    const placed = { ...interval, column };
    group.push(placed);
    heapPush(active, placed, byEnd);
  }
  flush();

  const byId = new Map(output.map(item => [item.id, item]));
  return intervals.map(item => byId.get(item.id)!).filter(Boolean);
}
