import { db, type Project, type Setting, type WorkLog } from '../db.ts';

export interface AppContext {
    activeProjects: { id: number; name: string; color: Project['color'] }[];
    archivedProjects: { id: number; name: string; color: Project['color'] }[];
    todaysWorklogs: { id: number; projectName: string; hours: number }[];
    config: { model: string; uiScale: number; locale: string };
}

const DEFAULT_MODEL = 'gemini-3-flash-preview';
const DEFAULT_LOCALE = 'cs-CZ';
const ACTIVE_PROJECTS_LIMIT = 20;
const TODAYS_WORKLOGS_LIMIT = 10;

function toIsoDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function pickActiveProjects(all: Project[]): { id: number; name: string; color: Project['color'] }[] {
    return all
        .filter((p) => p.isActive)
        .sort((a, b) => a.name.localeCompare(b.name, 'cs'))
        .slice(0, ACTIVE_PROJECTS_LIMIT)
        .map((p) => ({ id: p.id!, name: p.name, color: p.color }));
}

function pickArchivedProjects(all: Project[]): { id: number; name: string; color: Project['color'] }[] {
    return all
        .filter((p) => !p.isActive)
        .sort((a, b) => a.name.localeCompare(b.name, 'cs'))
        .slice(0, ACTIVE_PROJECTS_LIMIT)
        .map((p) => ({ id: p.id!, name: p.name, color: p.color }));
}

function pickTodaysWorklogs(all: WorkLog[], today: string): { id: number; projectName: string; hours: number }[] {
    return all
        .filter((w) => w.date === today)
        .sort((a, b) => a.id! - b.id!)
        .slice(0, TODAYS_WORKLOGS_LIMIT)
        .map((w) => ({ id: w.id!, projectName: w.projectName, hours: w.hours }));
}

export async function buildAppContext(): Promise<AppContext> {
    const today = toIsoDate(new Date());
    const [projects, worklogs, modelSetting, uiScaleSetting] = await Promise.all([
        db.projects.toArray().catch(() => [] as Project[]),
        db.workLogs.toArray().catch(() => [] as WorkLog[]),
        db.settings.get('gemini_model').catch(() => undefined) as Promise<Setting | undefined>,
        db.settings.get('ui_scale').catch(() => undefined) as Promise<Setting | undefined>,
    ]);
    return {
        activeProjects: pickActiveProjects(projects),
        archivedProjects: pickArchivedProjects(projects),
        todaysWorklogs: pickTodaysWorklogs(worklogs, today),
        config: {
            model: modelSetting?.value ?? DEFAULT_MODEL,
            uiScale: uiScaleSetting ? Number(uiScaleSetting.value) || 16 : 16,
            locale: DEFAULT_LOCALE,
        },
    };
}

export function renderAppContextSection(ctx: AppContext): string {
    const sections: string[] = [];
    sections.push('## 🗂️ Aktuální stav appky');
    sections.push('');
    if (ctx.activeProjects.length > 0) {
        sections.push('**Aktivní projekty:**');
        for (const p of ctx.activeProjects) {
            sections.push(`- ${p.name} (id=${p.id}, barva=${p.color})`);
        }
        if (ctx.activeProjects.length === ACTIVE_PROJECTS_LIMIT) {
            sections.push(`(+ další)`);
        }
    } else {
        sections.push('Žádné aktivní projekty.');
    }
    sections.push('');
    if (ctx.archivedProjects.length > 0) {
        sections.push('**Archivované projekty (nejsou platné pro nové WorkLogy):**');
        for (const p of ctx.archivedProjects) {
            sections.push(`- ${p.name} (id=${p.id}, barva=${p.color})`);
        }
        if (ctx.archivedProjects.length === ACTIVE_PROJECTS_LIMIT) {
            sections.push(`(+ další)`);
        }
        sections.push('Obnovení: pošli create_project se stejným názvem; aplikace obnoví původní ID.');
    } else {
        sections.push('Žádné archivované projekty.');
    }
    sections.push('');
    if (ctx.todaysWorklogs.length > 0) {
        sections.push('**Dnešní worklogy:**');
        for (const w of ctx.todaysWorklogs) {
            sections.push(`- ${w.projectName}: ${w.hours}h (id=${w.id})`);
        }
        if (ctx.todaysWorklogs.length === TODAYS_WORKLOGS_LIMIT) {
            sections.push(`(+ další)`);
        }
    } else {
        sections.push('Žádné dnešní worklogy.');
    }
    sections.push('');
    sections.push(`**Konfigurace:** model=${ctx.config.model}, ui_scale=${ctx.config.uiScale}, locale=${ctx.config.locale}`);
    return sections.join('\n');
}
