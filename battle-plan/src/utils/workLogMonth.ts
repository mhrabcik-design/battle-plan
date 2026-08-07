export function monthKeyToDate(key: string): Date {
    const [year, month] = key.split('-').map(Number);
    return new Date(year, month - 1, 1);
}

export function currentMonthKey(offset = 0, referenceDate = new Date()): string {
    const date = new Date(referenceDate);
    date.setDate(1);
    date.setMonth(date.getMonth() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function monthKeyToOffset(key: string, referenceDate = new Date()): number {
    const date = monthKeyToDate(key);
    return (date.getFullYear() - referenceDate.getFullYear()) * 12
        + (date.getMonth() - referenceDate.getMonth());
}

export function monthLabel(key: string): string {
    return monthKeyToDate(key).toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' });
}
