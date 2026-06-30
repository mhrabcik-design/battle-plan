import type { WorkLog } from '../db';

/**
 * Pracovní činnosti (`db.workLogs`) jsou oddělené od běžných `db.tasks` a `db.meetings`,
 * ale bezpečnostně filtrujeme texty popisků, aby se součet hodin v „Práci"
 *
 *   1. nepočítal u popisků, které jasně vypadají jako schůze / schůzka,
 *      (např. kdyby Martin nadiktoval „schůze na DEKu" a parser omylem vytvořil WorkLog),
 *   2. neukazoval v žádné summě pokud existuje `meetingHint`.
 *
 * Logika je konzervativní — slovo musí být celé slovo, case-insensitive,
 * s možností fallbacku na stem-match pro „schuz".
 */

const MEETING_HINT_REGEX = /\b(sch[uů]z[eyikou]+|jedn[aá]n[ií]|m[ií]ting|meeting|setk[aá]n[ií])\w*/i;

export interface FilterResult {
    workLogs: WorkLog[];
    hiddenCount: number;
}

/**
 * Vrací nové pole `WorkLog[]` očištěné o záznamy, jejichž `description`
 * nebo `projectName` vypadá jako schůzka/tentative. Současně vrací počet skrytých,
 * aby se v UI mohl zobrazit nenápadný tooltip.
 */
export function filterWorkLogsForPrace(logs: WorkLog[]): FilterResult {
    let hiddenCount = 0;
    const filtered: WorkLog[] = [];
    for (const log of logs) {
        if (looksLikeMeeting(log)) {
            hiddenCount += 1;
            continue;
        }
        filtered.push(log);
    }
    return { workLogs: filtered, hiddenCount };
}

export function looksLikeMeeting(log: WorkLog): boolean {
    const haystack = [log.description ?? '', log.projectName ?? '', log.people ?? '']
        .join(' \u00B7 ')
        .toLowerCase();
    if (!haystack.trim()) return false;
    return MEETING_HINT_REGEX.test(haystack);
}
