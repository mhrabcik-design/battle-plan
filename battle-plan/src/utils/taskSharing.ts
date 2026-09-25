import type { UnifiedTask } from '../types';

/** The same public text is used by the mail client and the clipboard fallback. */
export function buildTaskEmail(task: UnifiedTask): { subject: string; body: string; mailto: string } {
    const lines = [`=== ${task.title} ===`];
    if (task.type === 'meeting') {
        if (task.date || task.deadline) lines.push(`Datum: ${task.date || task.deadline}`);
    } else {
        if (task.date && task.date !== task.deadline) lines.push(`Datum: ${task.date}`);
        if (task.deadline) lines.push(`Termín: ${task.deadline}`);
    }
    if (task.isAllDay) lines.push('Celodenní');
    if (!task.isAllDay && !task.isGoogleTask && (task.type === 'task' || task.type === 'meeting')) {
        if (task.startTime) lines.push(`${task.type === 'meeting' ? 'Začátek' : 'Čas dokončení'}: ${task.startTime}`);
        if (task.duration !== undefined && Number.isFinite(task.duration) && task.duration > 0) {
            lines.push(`Délka: ${task.duration} min`);
        }
    }
    if (task.progress !== undefined && Number.isFinite(task.progress)) lines.push(`Pokrok: ${task.progress}%`);
    if (task.description) lines.push('', 'POPIS:', task.description);
    if (task.subTasks?.length) {
        lines.push('', 'PŘEHLED PODÚKOLŮ:', ...task.subTasks.map(st => `${st.completed ? '✅' : '☐'} ${st.title}`));
    }
    lines.push('', '--', 'Sdíleno z aplikace Bitevní Plán');
    const subject = `${task.title.replace(/[\r\n]+/g, ' ')} [BP]`;
    const body = lines.join('\n').replace(/\r\n|\r|\n/g, '\r\n');
    return { subject, body, mailto: `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` };
}
