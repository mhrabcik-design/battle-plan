import type { ExtractedWorkLog } from '../services/workLogExtractor';

export const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const toIsoDate = (date: Date): string => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
};

const addDays = (date: Date, days: number): Date => {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
};

export const previousWorkWeekDates = (referenceDate: Date): string[] => {
    const day = referenceDate.getDay();
    const daysSinceMonday = (day + 6) % 7;
    const currentMonday = addDays(referenceDate, -daysSinceMonday);
    const previousMonday = addDays(currentMonday, -7);
    return Array.from({ length: 5 }, (_, i) => toIsoDate(addDays(previousMonday, i)));
};

export const normalizePeopleList = (value: unknown): string[] => {
    if (Array.isArray(value)) {
        return value.map((p) => String(p).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean);
    }
    return [];
};

export const anonymousWorkers = (count: number, startAt = 1): string[] =>
    Array.from({ length: Math.max(0, count) }, (_, i) => `Pracovník ${i + startAt}`);

export const calculatePersonHours = (peopleCount: number, hoursPerPerson: number): number =>
    Math.round(peopleCount * hoursPerPerson * 100) / 100;

export const hasExplainedPersonHours = (totalHours: number, peopleCount?: number, hoursPerPerson?: number): boolean => {
    if (totalHours <= 24) return true;
    if (!peopleCount || peopleCount < 2 || !hoursPerPerson || hoursPerPerson <= 0) return false;
    return Math.abs(calculatePersonHours(peopleCount, hoursPerPerson) - totalHours) < 0.01;
};

const formatCalculationNote = (peopleCount: number, hoursPerPerson: number, totalHours: number): string =>
    `${peopleCount} ${peopleCount === 1 ? 'člověk' : peopleCount < 5 ? 'lidé' : 'lidí'} × ${hoursPerPerson} h = ${totalHours} h`;

export const createWorkLogProposal = (input: {
    projectName?: string;
    people?: string[] | string;
    hoursPerPerson?: number;
    totalHours?: number;
    description?: string;
    date: string;
    assumptions?: string[];
    calculationNote?: string;
}): ExtractedWorkLog => {
    const people = normalizePeopleList(input.people ?? []);
    const hoursPerPerson = Number(input.hoursPerPerson);
    const rawTotal = Number(input.totalHours);
    const hasHoursPerPerson = !Number.isNaN(hoursPerPerson) && hoursPerPerson > 0;
    const totalHours = !Number.isNaN(rawTotal) && rawTotal > 0
        ? rawTotal
        : hasHoursPerPerson
            ? calculatePersonHours(Math.max(people.length, 1), hoursPerPerson)
            : 0;
    return {
        projectName: (input.projectName ?? '').trim(),
        people: people.join(', '),
        hours: totalHours,
        hoursPerPerson: hasHoursPerPerson ? hoursPerPerson : undefined,
        peopleCount: people.length || undefined,
        calculationNote: input.calculationNote ?? (hasHoursPerPerson ? formatCalculationNote(Math.max(people.length, 1), hoursPerPerson, totalHours) : undefined),
        assumptions: input.assumptions ?? [],
        description: input.description?.trim() || '',
        date: dateRegex.test(input.date) ? input.date : toIsoDate(new Date()),
    };
};

export const buildRepeatedWorkLogEntries = (input: {
    dates: string[];
    projectName: string;
    people: string[];
    hoursPerPerson: number;
    description?: string;
    assumptions?: string[];
}): ExtractedWorkLog[] =>
    input.dates.map((date) =>
        createWorkLogProposal({
            date,
            projectName: input.projectName,
            people: input.people,
            hoursPerPerson: input.hoursPerPerson,
            description: input.description,
            assumptions: input.assumptions,
        }),
    );

export const applyDateScopedExtraWorkers = (
    entries: ExtractedWorkLog[],
    date: string,
    count: number,
): ExtractedWorkLog[] => {
    const existingAnonymous = new Set(
        entries.flatMap((entry) => normalizePeopleList(entry.people)).filter((name) => name.startsWith('Pracovník ')),
    );
    let nextIndex = existingAnonymous.size + 1;
    return entries.map((entry) => {
        if (entry.date !== date) return entry;
        const people = normalizePeopleList(entry.people);
        const extras = anonymousWorkers(count, nextIndex);
        nextIndex += extras.length;
        return createWorkLogProposal({
            ...entry,
            people: [...people, ...extras],
            hoursPerPerson: entry.hoursPerPerson,
            assumptions: entry.assumptions,
        });
    });
};
