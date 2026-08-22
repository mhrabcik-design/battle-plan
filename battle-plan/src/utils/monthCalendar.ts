export type MonthCalendarDay = {
    isoDate: string;
    dayNumber: number;
    isCurrentMonth: boolean;
    isSelected: boolean;
    isToday: boolean;
};

const parseIsoDate = (value: string): Date | null => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(year, month, day);

    return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
        ? date
        : null;
};

export const toLocalIsoDate = (date: Date): string => (
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
);

export const getCalendarMonthStart = (value: string, today = new Date()): Date => {
    const source = parseIsoDate(value) ?? today;
    return new Date(source.getFullYear(), source.getMonth(), 1);
};

export const shiftCalendarMonth = (month: Date, amount: number): Date => (
    new Date(month.getFullYear(), month.getMonth() + amount, 1)
);

export const buildMonthCalendar = (
    month: Date,
    selectedValue: string,
    today = new Date(),
): MonthCalendarDay[] => {
    const monthStart = new Date(month.getFullYear(), month.getMonth(), 1);
    const mondayOffset = (monthStart.getDay() + 6) % 7;
    const gridStart = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1 - mondayOffset);
    const todayValue = toLocalIsoDate(today);

    return Array.from({ length: 42 }, (_, index) => {
        const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
        const isoDate = toLocalIsoDate(date);
        return {
            isoDate,
            dayNumber: date.getDate(),
            isCurrentMonth: date.getMonth() === monthStart.getMonth() && date.getFullYear() === monthStart.getFullYear(),
            isSelected: isoDate === selectedValue,
            isToday: isoDate === todayValue,
        };
    });
};

export const formatDateValue = (value: string): string => {
    const date = parseIsoDate(value);
    return date
        ? date.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' })
        : 'Vybrat datum';
};
