import { db, type Project, type ProjectColor } from '../db.ts';
import { PROJECT_COLOR_VALUES } from '../utils/projectColors.ts';

type ProjectSource = NonNullable<Project['source']>;

interface ProjectAttribution {
    source?: ProjectSource;
    agentWriteId?: string;
}

export interface CreateProjectInput extends ProjectAttribution {
    name: string;
    color?: ProjectColor;
    confirmRestore?: boolean;
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

export function normalizeProjectName(name: string): string {
    return name.trim().toLowerCase();
}

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

function normalizedMatches(projects: Project[], name: string): Project[] {
    const normalizedName = normalizeProjectName(name);
    return projects.filter((project) => normalizeProjectName(project.name) === normalizedName);
}

function conflictResult(projects: Project[]): ProjectCatalogResult {
    return {
        outcome: 'conflict',
        projects: [...projects].sort((left, right) => (left.id ?? 0) - (right.id ?? 0)),
    };
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
        const matches = normalizedMatches(projects, normalizedName);

        if (matches.length > 1) return conflictResult(matches);
        if (matches.length === 1) {
            const match = matches[0]!;
            if (match.isActive) return { outcome: 'duplicate', project: match };
            if (!input.confirmRestore) return { outcome: 'archived-match', project: match };

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

        const currentMatches = normalizedMatches(projects, existing.name);
        if (currentMatches.length > 1) return conflictResult(currentMatches);

        if (normalizedName !== undefined) {
            const destinationMatches = normalizedMatches(projects, normalizedName)
                .filter((project) => project.id !== input.id);
            if (destinationMatches.length > 1) return conflictResult(destinationMatches);
            if (destinationMatches.length === 1) return { outcome: 'duplicate', project: destinationMatches[0]! };
        }

        const project = await putProject(existing, {
            ...(input.name === undefined ? {} : { name: input.name.trim() }),
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
        const matches = normalizedMatches(projects, existing.name);
        if (matches.length > 1) return conflictResult(matches);

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
        const matches = normalizedMatches(projects, existing.name);
        if (matches.length > 1) return conflictResult(matches);

        const project = await putProject(existing, {
            isActive: false,
            ...attributionPatch(input),
            updatedAt: Date.now(),
        });
        return { outcome: 'archived', project };
    });
}
