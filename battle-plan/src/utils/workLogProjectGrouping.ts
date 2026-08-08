import type { Project, ProjectColor, WorkLog } from '../db.ts';
import { normalizePeopleList } from './workLogBatch.ts';
import {
    buildProjectIdentityIndex,
    canonicalProject,
    normalizeProjectName,
} from './projectIdentityReconciliation.ts';

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
    for (const project of projects) {
        const key = normalizeProjectName(project.name);
        if (!key) continue;
        const group = catalogGroups.get(key);
        if (group) group.push(project);
        else catalogGroups.set(key, [project]);
    }
    const canonicalByProject = new Map<Project, Project>();
    const byId = new Map<number, Project>();
    for (const group of catalogGroups.values()) {
        const canonical = canonicalProject(group);
        for (const project of group) {
            canonicalByProject.set(project, canonical);
            if (project.id != null) byId.set(project.id, canonical);
        }
    }
    const byName = new Map<string, Project>();
    for (const [key, owners] of buildProjectIdentityIndex(projects)) {
        const canonicalKeys = new Set(owners.map((owner) => normalizeProjectName(owner.name)));
        if (canonicalKeys.size > 1) continue;
        const owner = canonicalProject(owners);
        byName.set(key, canonicalByProject.get(owner) ?? owner);
    }
    return { byName, byId };
}

export function groupWorkLogsByProject(
    workLogs: WorkLog[],
    projectsOrIndex: Project[] | WorkLogProjectIndex = [],
): WorkLogProjectGroup[] {
    const projectIndex = Array.isArray(projectsOrIndex)
        ? createWorkLogProjectIndex(projectsOrIndex)
        : projectsOrIndex;
    const grouped = new Map<string, Omit<WorkLogProjectGroup, 'people'> & { peopleSet: Set<string> }>();

    for (const workLog of workLogs) {
        const normalizedName = normalizeProjectName(workLog.projectName);
        const project = projectIndex.byId.get(workLog.projectId) ?? projectIndex.byName.get(normalizedName);
        const key = project?.id != null
            ? `project-id:${project.id}`
            : normalizedName || `project-id:${workLog.projectId}`;
        let group = grouped.get(key);
        if (!group) {
            group = {
                key,
                name: project?.name.trim() || workLog.projectName.trim(),
                color: project?.color ?? 'slate',
                hours: 0,
                count: 0,
                peopleSet: new Set(),
            };
            grouped.set(key, group);
        }

        group.hours += workLog.hours;
        group.count++;
        for (const person of normalizePeopleList(workLog.people)) {
            group.peopleSet.add(person);
        }
    }

    return Array.from(grouped.values(), (group) => ({
        key: group.key,
        name: group.name,
        color: group.color,
        hours: group.hours,
        count: group.count,
        people: [...group.peopleSet],
    }));
}
