import type { Project, ProjectColor, WorkLog } from '../db.ts';
import { normalizePeopleList } from './workLogBatch.ts';
import { canonicalProject, normalizeProjectName } from './projectIdentityReconciliation.ts';

export interface WorkLogProjectGroup {
    key: string;
    name: string;
    color: ProjectColor;
    hours: number;
    count: number;
    people: string[];
}

export interface WorkLogProjectIndex {
    byName: Map<string, Project>;
    byId: Map<number, Project>;
}

export function createWorkLogProjectIndex(projects: Project[] = []): WorkLogProjectIndex {
    const catalogGroups = new Map<string, Project[]>();
    const byId = new Map<number, Project>();
    for (const project of projects) {
        if (project.id != null) byId.set(project.id, project);
        const key = normalizeProjectName(project.name);
        if (!key) continue;
        const group = catalogGroups.get(key);
        if (group) group.push(project);
        else catalogGroups.set(key, [project]);
    }
    const byName = new Map(Array.from(catalogGroups, ([key, group]) => [key, canonicalProject(group)]));
    return { byName, byId };
}

export function groupWorkLogsByProject(
    workLogs: WorkLog[],
    projectsOrIndex: Project[] | WorkLogProjectIndex = [],
): WorkLogProjectGroup[] {
    const projectIndex = Array.isArray(projectsOrIndex)
        ? createWorkLogProjectIndex(projectsOrIndex)
        : projectsOrIndex;
    const grouped = new Map<string, WorkLogProjectGroup & { peopleSet: Set<string> }>();

    for (const workLog of workLogs) {
        const normalizedName = normalizeProjectName(workLog.projectName);
        const key = normalizedName || `project-id:${workLog.projectId}`;
        let group = grouped.get(key);
        if (!group) {
            const project = projectIndex.byName.get(normalizedName) ?? projectIndex.byId.get(workLog.projectId);
            group = {
                key,
                name: project?.name.trim() || workLog.projectName.trim(),
                color: project?.color ?? 'slate',
                hours: 0,
                count: 0,
                people: [],
                peopleSet: new Set(),
            };
            grouped.set(key, group);
        }

        group.hours += workLog.hours;
        group.count++;
        for (const person of normalizePeopleList(workLog.people)) {
            if (group.peopleSet.has(person)) continue;
            group.peopleSet.add(person);
            group.people.push(person);
        }
    }

    return Array.from(grouped.values(), (group) => ({
        key: group.key,
        name: group.name,
        color: group.color,
        hours: group.hours,
        count: group.count,
        people: group.people,
    }));
}
