import { db, type Project, type ProjectColor } from '../db.ts';
import { PROJECT_COLOR_VALUES } from '../utils/projectColors.ts';
import {
    buildProjectIdentityIndex,
    normalizeProjectAliases,
    normalizeProjectName,
    projectIdentityNames,
    resolveProjectIdentity,
} from '../utils/projectIdentityReconciliation.ts';

export { normalizeProjectName } from '../utils/projectIdentityReconciliation.ts';

type ProjectSource = NonNullable<Project['source']>;

interface ProjectAttribution {
    source?: ProjectSource;
    agentWriteId?: string;
}

export interface CreateProjectInput extends ProjectAttribution {
    name: string;
    color?: ProjectColor;
    confirmRestore?: boolean | 'canonical-only';
}

export interface UpdateProjectInput extends ProjectAttribution {
    id: number;
    name?: string;
    color?: ProjectColor;
}

export interface RestoreProjectInput extends ProjectAttribution {
    id: number;
    color?: ProjectColor;
}

export interface ArchiveProjectInput extends ProjectAttribution {
    id: number;
}

export type ProjectCatalogResult =
    | { outcome: 'created' | 'restored' | 'updated' | 'archived'; project: Project }
    | { outcome: 'archived-match' | 'duplicate'; project: Project }
    | { outcome: 'conflict'; projects: Project[] }
    | { outcome: 'validation'; message: string };

export interface ProjectMergeSelection {
    sourceProjectId: number;
    survivorProjectId: number;
}

export interface ProjectMergePreview {
    token: string;
    source: Project;
    survivor: Project;
    sourceWorkLogCount: number;
    survivorWorkLogCount: number;
}

export type ProjectMergePreviewResult =
    | { outcome: 'ready'; preview: ProjectMergePreview }
    | { outcome: 'conflict'; projects: Project[] }
    | { outcome: 'validation'; message: string };

export interface MergeProjectsInput extends ProjectMergeSelection {
    previewToken: string;
}

export type ProjectMergeResult =
    | { outcome: 'merged'; project: Project; workLogsRelinked: number }
    | { outcome: 'stale'; message: string }
    | { outcome: 'conflict'; projects: Project[] }
    | { outcome: 'validation'; message: string };

function isProjectColor(value: unknown): value is ProjectColor {
    return PROJECT_COLOR_VALUES.includes(value as ProjectColor);
}

function validateId(id: number): string | null {
    return Number.isSafeInteger(id) && id > 0 ? null : 'project id missing';
}

function validateColor(color: unknown): string | null {
    return color === undefined || isProjectColor(color) ? null : 'invalid project color';
}

function attributionPatch(
    input: ProjectAttribution,
): Pick<Project, 'source' | 'agent_write_id'> | Record<never, never> {
    if (!input.source) return {};
    return {
        source: input.source,
        agent_write_id: input.source === 'agent' ? input.agentWriteId : undefined,
    };
}

function conflictResult(projects: Project[]): ProjectCatalogResult {
    return {
        outcome: 'conflict',
        projects: sortedProjects(projects),
    };
}

function sortedProjects(projects: Project[]): Project[] {
    return [...projects].sort((left, right) => (left.id ?? 0) - (right.id ?? 0));
}

function validateMergeSelection(input: ProjectMergeSelection): string | null {
    const sourceError = validateId(input.sourceProjectId);
    if (sourceError) return `source ${sourceError}`;
    const survivorError = validateId(input.survivorProjectId);
    if (survivorError) return `survivor ${survivorError}`;
    return input.sourceProjectId === input.survivorProjectId
        ? 'source and survivor must be different projects'
        : null;
}

function projectState(project: Project): object {
    return {
        id: project.id ?? null,
        name: project.name,
        aliases: normalizeProjectAliases(project.name, project.aliases),
        color: project.color,
        isActive: project.isActive,
        source: project.source ?? null,
        agent_write_id: project.agent_write_id ?? null,
        updatedAt: project.updatedAt,
        createdAt: project.createdAt,
    };
}

function mergePreviewToken(projects: Project[], source: Project, survivor: Project): string {
    const ownership = [...buildProjectIdentityIndex(projects)]
        .sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1)
        .map(([name, owners]) => [
            name,
            owners.map((owner) => owner.id ?? null).sort((left, right) => (left ?? 0) - (right ?? 0)),
        ]);
    return JSON.stringify({
        direction: [source.id, survivor.id],
        source: projectState(source),
        survivor: projectState(survivor),
        ownership,
    });
}

function mergeIdentityConflicts(projects: Project[], source: Project, survivor: Project): Project[] {
    const selectedIds = new Set([source.id, survivor.id]);
    const index = buildProjectIdentityIndex(projects);
    const conflicts = new Map<number, Project>();
    for (const name of [...projectIdentityNames(source), ...projectIdentityNames(survivor)]) {
        const owners = index.get(normalizeProjectName(name)) ?? [];
        if (!owners.some((owner) => !selectedIds.has(owner.id))) continue;
        for (const owner of owners) {
            if (owner.id != null) conflicts.set(owner.id, owner);
        }
    }
    return sortedProjects([...conflicts.values()]);
}

function nextIdentityTimestamp(...timestamps: number[]): number {
    const finiteTimestamps = timestamps.filter(Number.isFinite);
    return Math.max(Date.now(), ...finiteTimestamps) + 1;
}

async function putProject(existing: Project, changes: Partial<Project>): Promise<Project> {
    const project: Project = { ...existing, ...changes };
    await db.projects.put(project);
    return project;
}

export async function createProject(input: CreateProjectInput): Promise<ProjectCatalogResult> {
    const normalizedName = normalizeProjectName(input.name ?? '');
    if (!normalizedName) return { outcome: 'validation', message: 'name required' };
    const colorError = validateColor(input.color);
    if (colorError) return { outcome: 'validation', message: colorError };

    return db.transaction('rw', db.projects, async () => {
        const projects = await db.projects.toArray();
        const identity = resolveProjectIdentity(projects, normalizedName);

        if (identity.outcome === 'conflict') return conflictResult(identity.projects);
        if (identity.outcome === 'resolved') {
            const match = identity.project;
            if (match.isActive) return { outcome: 'duplicate', project: match };
            const restoreConfirmed = input.confirmRestore === true
                || (
                    input.confirmRestore === 'canonical-only'
                    && normalizeProjectName(match.name) === normalizedName
                );
            if (!restoreConfirmed) return { outcome: 'archived-match', project: match };

            const project = await putProject(match, {
                isActive: true,
                ...(input.color === undefined ? {} : { color: input.color }),
                ...attributionPatch(input),
                updatedAt: Date.now(),
            });
            return { outcome: 'restored', project };
        }

        const now = Date.now();
        const project: Project = {
            name: input.name.trim(),
            color: input.color ?? 'slate',
            isActive: true,
            source: input.source ?? 'user',
            agent_write_id: input.source === 'agent' ? input.agentWriteId : undefined,
            createdAt: now,
            updatedAt: now,
        };
        const id = await db.projects.add(project);
        return { outcome: 'created', project: { ...project, id: id as number } };
    });
}

export async function updateProject(input: UpdateProjectInput): Promise<ProjectCatalogResult> {
    const idError = validateId(input.id);
    if (idError) return { outcome: 'validation', message: idError };
    if (input.name === undefined && input.color === undefined) {
        return { outcome: 'validation', message: 'project changes required' };
    }
    const normalizedName = input.name === undefined ? undefined : normalizeProjectName(input.name);
    if (normalizedName === '') return { outcome: 'validation', message: 'name required' };
    const colorError = validateColor(input.color);
    if (colorError) return { outcome: 'validation', message: colorError };

    return db.transaction('rw', db.projects, async () => {
        const projects = await db.projects.toArray();
        const existing = projects.find((project) => project.id === input.id);
        if (!existing) return { outcome: 'validation', message: 'project not found' };

        const currentIdentity = resolveProjectIdentity(projects, existing.name);
        if (currentIdentity.outcome === 'conflict') return conflictResult(currentIdentity.projects);

        if (normalizedName !== undefined) {
            const destination = resolveProjectIdentity(projects, normalizedName);
            if (destination.outcome === 'conflict') return conflictResult(destination.projects);
            if (destination.outcome === 'resolved' && destination.project.id !== input.id) {
                return { outcome: 'duplicate', project: destination.project };
            }
        }

        const nextName = input.name === undefined ? existing.name : input.name.trim();
        const project = await putProject(existing, {
            ...(input.name === undefined ? {} : {
                name: nextName,
                aliases: normalizeProjectAliases(nextName, projectIdentityNames(existing)),
            }),
            ...(input.color === undefined ? {} : { color: input.color }),
            ...attributionPatch(input),
            updatedAt: Date.now(),
        });
        return { outcome: 'updated', project };
    });
}

export async function restoreProject(input: RestoreProjectInput): Promise<ProjectCatalogResult> {
    const idError = validateId(input.id);
    if (idError) return { outcome: 'validation', message: idError };
    const colorError = validateColor(input.color);
    if (colorError) return { outcome: 'validation', message: colorError };

    return db.transaction('rw', db.projects, async () => {
        const projects = await db.projects.toArray();
        const existing = projects.find((project) => project.id === input.id);
        if (!existing) return { outcome: 'validation', message: 'project not found' };
        const identity = resolveProjectIdentity(projects, existing.name);
        if (identity.outcome === 'conflict') return conflictResult(identity.projects);

        const project = await putProject(existing, {
            isActive: true,
            ...(input.color === undefined ? {} : { color: input.color }),
            ...attributionPatch(input),
            updatedAt: Date.now(),
        });
        return { outcome: 'restored', project };
    });
}

export async function archiveProject(input: ArchiveProjectInput): Promise<ProjectCatalogResult> {
    const idError = validateId(input.id);
    if (idError) return { outcome: 'validation', message: idError };

    return db.transaction('rw', db.projects, async () => {
        const projects = await db.projects.toArray();
        const existing = projects.find((project) => project.id === input.id);
        if (!existing) return { outcome: 'validation', message: 'project not found' };
        const identity = resolveProjectIdentity(projects, existing.name);
        if (identity.outcome === 'conflict') return conflictResult(identity.projects);

        const project = await putProject(existing, {
            isActive: false,
            ...attributionPatch(input),
            updatedAt: Date.now(),
        });
        return { outcome: 'archived', project };
    });
}

export async function previewProjectMerge(input: ProjectMergeSelection): Promise<ProjectMergePreviewResult> {
    const selectionError = validateMergeSelection(input);
    if (selectionError) return { outcome: 'validation', message: selectionError };

    return db.transaction('r', db.projects, db.workLogs, async () => {
        const projects = await db.projects.toArray();
        const source = projects.find((project) => project.id === input.sourceProjectId);
        const survivor = projects.find((project) => project.id === input.survivorProjectId);
        if (!source) return { outcome: 'validation', message: 'source project not found' };
        if (!survivor) return { outcome: 'validation', message: 'survivor project not found' };
        if (!survivor.isActive) return { outcome: 'validation', message: 'survivor project must be active' };

        const conflicts = mergeIdentityConflicts(projects, source, survivor);
        if (conflicts.length > 0) return { outcome: 'conflict', projects: conflicts };

        const [sourceWorkLogCount, survivorWorkLogCount] = await Promise.all([
            db.workLogs.where('projectId').equals(source.id!).count(),
            db.workLogs.where('projectId').equals(survivor.id!).count(),
        ]);
        return {
            outcome: 'ready',
            preview: {
                token: mergePreviewToken(projects, source, survivor),
                source,
                survivor,
                sourceWorkLogCount,
                survivorWorkLogCount,
            },
        };
    });
}

export async function mergeProjects(input: MergeProjectsInput): Promise<ProjectMergeResult> {
    const selectionError = validateMergeSelection(input);
    if (selectionError) return { outcome: 'validation', message: selectionError };
    if (!input.previewToken) return { outcome: 'validation', message: 'merge preview required' };

    return db.transaction('rw', db.projects, db.workLogs, async () => {
        const projects = await db.projects.toArray();
        const source = projects.find((project) => project.id === input.sourceProjectId);
        const survivor = projects.find((project) => project.id === input.survivorProjectId);
        if (!source || !survivor) return { outcome: 'stale', message: 'selected project no longer exists' };
        if (!survivor.isActive) return { outcome: 'stale', message: 'survivor project is no longer active' };
        if (mergePreviewToken(projects, source, survivor) !== input.previewToken) {
            return { outcome: 'stale', message: 'project identity changed after preview' };
        }

        const conflicts = mergeIdentityConflicts(projects, source, survivor);
        if (conflicts.length > 0) return { outcome: 'conflict', projects: conflicts };

        const aliases = normalizeProjectAliases(survivor.name, [
            ...projectIdentityNames(survivor),
            ...projectIdentityNames(source),
        ]);
        const updatedAt = nextIdentityTimestamp(source.updatedAt, survivor.updatedAt);
        const mergedProject: Project = { ...survivor, aliases, updatedAt };
        await db.projects.put(mergedProject);
        const workLogsRelinked = await db.workLogs
            .where('projectId')
            .equals(source.id!)
            .modify({ projectId: survivor.id! });
        await db.projects.delete(source.id!);

        return { outcome: 'merged', project: mergedProject, workLogsRelinked };
    });
}
