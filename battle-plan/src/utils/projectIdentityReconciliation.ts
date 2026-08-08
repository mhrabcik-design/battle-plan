import type { Table } from 'dexie';

import type { Project, WorkLog } from '../db.ts';

export interface ProjectIdentityReconciliationResult {
    projectsCreated: number;
    projectsMerged: number;
    workLogsRelinked: number;
    projectIdRemaps: Map<number, number>;
}

export class ProjectIdentityConflictError extends Error {
    readonly identityKeys: string[];

    constructor(message: string, identityKeys: string[]) {
        super(message);
        this.name = 'ProjectIdentityConflictError';
        this.identityKeys = [...identityKeys].sort(compareIdentityKeys);
    }
}

export function normalizeProjectName(name: string): string {
    return name.trim().toLowerCase();
}

function compareIdentityKeys(left: string, right: string): number {
    return left === right ? 0 : left < right ? -1 : 1;
}

function compareProjectDisplayNames(left: string, right: string): number {
    const keyOrder = compareIdentityKeys(normalizeProjectName(left), normalizeProjectName(right));
    return keyOrder === 0 ? compareIdentityKeys(left, right) : keyOrder;
}

/**
 * Sanitizes optional/legacy alias metadata without mutating its source row.
 * The retained display spelling is the first valid occurrence, while the
 * resulting list is ordered by normalized identity for stable persistence.
 */
export function normalizeProjectAliases(canonicalName: string, aliases: unknown): string[] {
    if (!Array.isArray(aliases)) return [];
    const canonicalKey = normalizeProjectName(canonicalName);
    const aliasesByKey = new Map<string, string>();
    for (const alias of aliases) {
        if (typeof alias !== 'string') continue;
        const displayName = alias.trim();
        const key = normalizeProjectName(displayName);
        if (!key || key === canonicalKey || aliasesByKey.has(key)) continue;
        aliasesByKey.set(key, displayName);
    }
    return [...aliasesByKey]
        .sort(([left], [right]) => compareIdentityKeys(left, right))
        .map(([, displayName]) => displayName);
}

export function projectIdentityNames(project: Project): string[] {
    const canonicalName = project.name.trim();
    return canonicalName
        ? [canonicalName, ...normalizeProjectAliases(canonicalName, project.aliases)]
        : normalizeProjectAliases('', project.aliases);
}

export type ProjectIdentityResolution =
    | { outcome: 'resolved'; project: Project }
    | { outcome: 'missing' }
    | { outcome: 'conflict'; projects: Project[] };

export function buildProjectIdentityIndex(projects: Project[]): Map<string, Project[]> {
    const index = new Map<string, Project[]>();
    for (const project of projects) {
        for (const name of projectIdentityNames(project)) {
            const key = normalizeProjectName(name);
            if (!key) continue;
            const owners = index.get(key) ?? [];
            owners.push(project);
            index.set(key, owners);
        }
    }
    return index;
}

export function resolveProjectIdentityFromIndex(
    index: Map<string, Project[]>,
    name: string,
): ProjectIdentityResolution {
    const key = normalizeProjectName(name);
    if (!key) return { outcome: 'missing' };
    const owners = index.get(key) ?? [];
    if (owners.length === 0) return { outcome: 'missing' };
    if (owners.length === 1) return { outcome: 'resolved', project: owners[0]! };
    return {
        outcome: 'conflict',
        projects: [...owners].sort((left, right) => (left.id ?? 0) - (right.id ?? 0)),
    };
}

export function resolveProjectIdentity(projects: Project[], name: string): ProjectIdentityResolution {
    return resolveProjectIdentityFromIndex(buildProjectIdentityIndex(projects), name);
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

    type IdentityGroup = {
        key: string;
        members: Project[];
        canonical: Project;
    };
    const groups = [...projectsByName]
        .sort(([left], [right]) => compareIdentityKeys(left, right))
        .map(([key, members]): IdentityGroup => ({ key, members, canonical: canonicalProject(members) }));
    const groupByKey = new Map(groups.map((group) => [group.key, group]));

    // An alias may have one owning canonical group. If that alias is also a
    // canonical name, the canonical group points toward the alias owner. This
    // direction makes a manually chosen survivor authoritative over a stale
    // source row, regardless of timestamps or input ordering.
    const aliasOwners = new Map<string, Set<string>>();
    for (const group of groups) {
        for (const project of group.members) {
            for (const alias of normalizeProjectAliases(project.name, project.aliases)) {
                const aliasKey = normalizeProjectName(alias);
                const owners = aliasOwners.get(aliasKey) ?? new Set<string>();
                owners.add(group.key);
                aliasOwners.set(aliasKey, owners);
            }
        }
    }
    for (const [aliasKey, owners] of aliasOwners) {
        if (owners.size > 1) {
            throw new ProjectIdentityConflictError(
                `project alias ${aliasKey} has competing owners`,
                [aliasKey, ...owners],
            );
        }
    }

    const ownerByCanonicalKey = new Map<string, string>();
    for (const [aliasKey, owners] of aliasOwners) {
        if (!groupByKey.has(aliasKey)) continue;
        const ownerKey = [...owners][0]!;
        if (ownerKey !== aliasKey) ownerByCanonicalKey.set(aliasKey, ownerKey);
    }

    const rootByGroupKey = new Map<string, string>();
    function identityRoot(startKey: string): string {
        const known = rootByGroupKey.get(startKey);
        if (known) return known;
        const path: string[] = [];
        const seen = new Set<string>();
        let key = startKey;
        while (ownerByCanonicalKey.has(key)) {
            if (seen.has(key)) {
                throw new ProjectIdentityConflictError('project alias cycle detected', [...path, key]);
            }
            seen.add(key);
            path.push(key);
            key = ownerByCanonicalKey.get(key)!;
        }
        for (const pathKey of path) rootByGroupKey.set(pathKey, key);
        rootByGroupKey.set(key, key);
        return key;
    }
    for (const group of groups) identityRoot(group.key);

    const groupsByRoot = new Map<string, IdentityGroup[]>();
    for (const group of groups) {
        const root = identityRoot(group.key);
        const component = groupsByRoot.get(root) ?? [];
        component.push(group);
        groupsByRoot.set(root, component);
    }

    const canonicalByName = new Map<string, Project>();
    const canonicalByProjectId = new Map<number, Project>();
    const projectsToPut: Project[] = [];
    const projectIdsToDelete: number[] = [];
    for (const [rootKey, component] of [...groupsByRoot].sort(([left], [right]) => compareIdentityKeys(left, right))) {
        const rootGroup = groupByKey.get(rootKey)!;
        const canonical = rootGroup.canonical;
        const canonicalId = canonical.id!;
        const componentProjects = component.flatMap((group) => group.members);
        const canonicalNames = componentProjects
            .map((project) => project.name.trim())
            .filter(Boolean)
            .sort(compareProjectDisplayNames);
        const inheritedAliases = componentProjects
            .flatMap((project) => normalizeProjectAliases(project.name, project.aliases))
            .sort(compareProjectDisplayNames);
        // A canonical spelling is more authoritative than a stale alias
        // spelling for the same identity; the sorted inputs also make the
        // serialized union independent of table/incoming array order.
        const aliases = normalizeProjectAliases(canonical.name, [...canonicalNames, ...inheritedAliases]);
        const merged: Project = {
            ...canonical,
            name: canonical.name.trim(),
            ...(aliases.length > 0 || canonical.aliases !== undefined ? { aliases } : {}),
            // Exact canonical duplicates retain the legacy min/max repair.
            // Absorbed alias-linked groups never overwrite survivor metadata.
            createdAt: timestamp(rootGroup.members.map((project) => project.createdAt), canonical.createdAt, 'min'),
            updatedAt: timestamp(rootGroup.members.map((project) => project.updatedAt), canonical.updatedAt, 'max'),
        };
        if (
            merged.name !== canonical.name
            || JSON.stringify(merged.aliases) !== JSON.stringify(canonical.aliases)
            || merged.createdAt !== canonical.createdAt
            || merged.updatedAt !== canonical.updatedAt
        ) {
            projectsToPut.push(merged);
        }
        for (const name of projectIdentityNames(merged)) {
            canonicalByName.set(normalizeProjectName(name), merged);
        }
        for (const project of componentProjects) canonicalByProjectId.set(project.id!, merged);

        const duplicateIds = componentProjects
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
