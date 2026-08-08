import type { Table } from 'dexie';

import type { Project, WorkLog } from '../db.ts';

export interface ProjectIdentityReconciliationResult {
    projectsCreated: number;
    projectsMerged: number;
    workLogsRelinked: number;
    projectIdRemaps: Map<number, number>;
}

export function normalizeProjectName(name: string): string {
    return name.trim().toLowerCase();
}

export function canonicalProject(projects: Project[]): Project {
    return [...projects].sort((left, right) => {
        if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
        if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
        if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
        return (left.id ?? 0) - (right.id ?? 0);
    })[0]!;
}

function timestamp(values: number[], fallback: number, select: 'min' | 'max'): number {
    const finite = values.filter(Number.isFinite);
    return finite.length === 0 ? fallback : Math[select](...finite);
}

/**
 * Repairs the catalog invariant that one normalized name means one project.
 * Callers own the surrounding read/write transaction over both supplied tables.
 */
export async function reconcileProjectIdentities(
    projectsTable: Table<Project, number>,
    workLogsTable: Table<WorkLog, number>,
): Promise<ProjectIdentityReconciliationResult> {
    const result: ProjectIdentityReconciliationResult = {
        projectsCreated: 0,
        projectsMerged: 0,
        workLogsRelinked: 0,
        projectIdRemaps: new Map(),
    };
    const projects = await projectsTable.toArray();
    const workLogs = await workLogsTable.toArray();
    const projectsByName = new Map<string, Project[]>();

    for (const project of projects) {
        const key = normalizeProjectName(project.name);
        if (!key || project.id == null) continue;
        const group = projectsByName.get(key);
        if (group) group.push(project);
        else projectsByName.set(key, [project]);
    }

    const canonicalByName = new Map<string, Project>();
    const canonicalByProjectId = new Map<number, Project>();
    const projectsToPut: Project[] = [];
    const projectIdsToDelete: number[] = [];
    for (const [key, group] of projectsByName) {
        const canonical = canonicalProject(group);
        const canonicalId = canonical.id!;
        const merged: Project = {
            ...canonical,
            name: canonical.name.trim(),
            createdAt: timestamp(group.map((project) => project.createdAt), canonical.createdAt, 'min'),
            updatedAt: timestamp(group.map((project) => project.updatedAt), canonical.updatedAt, 'max'),
        };
        if (
            merged.name !== canonical.name
            || merged.createdAt !== canonical.createdAt
            || merged.updatedAt !== canonical.updatedAt
        ) {
            projectsToPut.push(merged);
        }
        canonicalByName.set(key, merged);
        for (const project of group) canonicalByProjectId.set(project.id!, merged);

        const duplicateIds = group
            .map((project) => project.id)
            .filter((id): id is number => id != null && id !== canonicalId);
        if (duplicateIds.length > 0) {
            projectIdsToDelete.push(...duplicateIds);
            for (const duplicateId of duplicateIds) {
                result.projectIdRemaps.set(duplicateId, canonicalId);
            }
            result.projectsMerged += duplicateIds.length;
        }
    }
    if (projectsToPut.length > 0) await projectsTable.bulkPut(projectsToPut);
    if (projectIdsToDelete.length > 0) await projectsTable.bulkDelete(projectIdsToDelete);

    const orphanedWorkLogsByName = new Map<string, WorkLog[]>();
    const workLogsToRelink: WorkLog[] = [];
    for (const workLog of workLogs) {
        const canonical = canonicalByProjectId.get(workLog.projectId);
        if (canonical) {
            if (workLog.projectId !== canonical.id) {
                workLogsToRelink.push({ ...workLog, projectId: canonical.id! });
                result.workLogsRelinked++;
            }
            continue;
        }

        const key = normalizeProjectName(workLog.projectName);
        if (!key || workLog.id == null) continue;
        const group = orphanedWorkLogsByName.get(key);
        if (group) group.push(workLog);
        else orphanedWorkLogsByName.set(key, [workLog]);
    }

    for (const [key, group] of orphanedWorkLogsByName) {
        let canonical = canonicalByName.get(key);
        if (!canonical) {
            const now = Date.now();
            const project: Project = {
                name: group[0]!.projectName.trim(),
                color: 'slate',
                isActive: true,
                createdAt: timestamp(group.map((workLog) => workLog.createdAt), now, 'min'),
                updatedAt: timestamp(group.map((workLog) => workLog.updatedAt), now, 'max'),
            };
            const id = await projectsTable.add(project);
            canonical = { ...project, id };
            canonicalByName.set(key, canonical);
            result.projectsCreated++;
        }

        for (const workLog of group) {
            if (workLog.projectId === canonical.id) continue;
            workLogsToRelink.push({ ...workLog, projectId: canonical.id! });
            result.workLogsRelinked++;
        }
    }
    if (workLogsToRelink.length > 0) await workLogsTable.bulkPut(workLogsToRelink);

    return result;
}
