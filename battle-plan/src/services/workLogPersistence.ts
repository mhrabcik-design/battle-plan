import { db, type Project, type WorkLog } from '../db.ts';
import { normalizeProjectName } from './projectCatalog.ts';
import {
    buildProjectIdentityIndex,
    projectIdentityNames,
    resolveProjectIdentityFromIndex,
} from '../utils/projectIdentityReconciliation.ts';

export type NewWorkLogDraft = Omit<WorkLog, 'id' | 'projectName'> & {
    projectName?: string;
};

export type WorkLogProjectSelection = Pick<Project, 'name'> & { id: number };

export type WorkLogEditableChanges = Partial<Omit<
    WorkLog,
    'id' | 'projectId' | 'projectName' | 'source' | 'agent_write_id' | 'createdAt'
>>;

export class ProjectUnavailableError extends Error {
    constructor() {
        super('project-not-found');
        this.name = 'ProjectUnavailableError';
    }
}

export function isMatchingActiveProject(
    project: Project | undefined,
    selection: WorkLogProjectSelection,
): project is Project & { id: number } {
    return project?.id === selection.id
        && project.isActive
        && projectIdentityNames(project).some(
            (name) => normalizeProjectName(name) === normalizeProjectName(selection.name),
        );
}

function activeProjectFromCatalog(
    project: Project | undefined,
    selection: WorkLogProjectSelection,
    identityIndex?: Map<string, Project[]>,
): Project & { id: number } {
    if (isMatchingActiveProject(project, selection)) return project;
    if (!project && selection.name && identityIndex) {
        const identity = resolveProjectIdentityFromIndex(identityIndex, selection.name);
        if (identity.outcome === 'resolved' && identity.project.id != null && identity.project.isActive) {
            return identity.project as Project & { id: number };
        }
    }
    throw new ProjectUnavailableError();
}

async function requireActiveProject(
    projectId: number,
    snapshottedName?: string,
): Promise<Project & { id: number }> {
    const project = await db.projects.get(projectId);
    const selection = { id: projectId, name: snapshottedName ?? project?.name ?? '' };
    if (project) return activeProjectFromCatalog(project, selection);

    // A manual merge removes the absorbed local id. Pending portable writes
    // may still carry that stale id, so only a missing id may fall back to an
    // unambiguous canonical/alias lookup. An id that now belongs to another
    // project remains a hard mismatch and cannot be silently redirected.
    const identityIndex = snapshottedName
        ? buildProjectIdentityIndex(await db.projects.toArray())
        : undefined;
    return activeProjectFromCatalog(project, selection, identityIndex);
}

/**
 * Validates every selected project and writes the whole batch in one transaction.
 * A stale, archived, missing, or device-local id/name mismatch aborts every row.
 */
export async function addWorkLogsWithActiveProjects(
    drafts: readonly NewWorkLogDraft[],
): Promise<WorkLog[]> {
    return db.transaction('rw', [db.projects, db.workLogs], async () => {
        const projects = await db.projects.toArray();
        const projectsById = new Map(projects.map((project) => [project.id, project]));
        const identityIndex = buildProjectIdentityIndex(projects);
        const validated = drafts.map((draft) => {
            const project = projectsById.get(draft.projectId);
            return {
                draft,
                project: activeProjectFromCatalog(
                    project,
                    { id: draft.projectId, name: draft.projectName ?? project?.name ?? '' },
                    identityIndex,
                ),
            };
        });
        const saved: WorkLog[] = [];

        for (const { draft, project } of validated) {
            const workLog: Omit<WorkLog, 'id'> = {
                ...draft,
                projectId: project.id,
                projectName: project.name,
            };
            const id = await db.workLogs.add(workLog);
            saved.push({ ...workLog, id: id as number });
        }

        return saved;
    });
}

export async function addWorkLogWithActiveProject(draft: NewWorkLogDraft): Promise<WorkLog> {
    const [saved] = await addWorkLogsWithActiveProjects([draft]);
    return saved!;
}

interface UpdateWorkLogInput {
    id: number;
    selectedProject: WorkLogProjectSelection | null;
    changes: WorkLogEditableChanges;
}

/**
 * Retains the stored project snapshot when selection is unchanged. A changed
 * assignment must still point at the same active local id/name pair at commit.
 */
export async function updateWorkLogWithProjectSelection(
    input: UpdateWorkLogInput,
): Promise<WorkLog> {
    return db.transaction('rw', [db.projects, db.workLogs], async () => {
        const existing = await db.workLogs.get(input.id);
        if (!existing) throw new Error('worklog-not-found');

        let assignment: Pick<WorkLog, 'projectId' | 'projectName'> = {
            projectId: existing.projectId,
            projectName: existing.projectName,
        };
        const selection = input.selectedProject;
        const assignmentChanged = selection !== null && (
            selection.id !== existing.projectId
            || normalizeProjectName(selection.name) !== normalizeProjectName(existing.projectName)
        );

        if (selection && assignmentChanged) {
            const activeProject = await requireActiveProject(selection.id, selection.name);
            assignment = { projectId: activeProject.id, projectName: activeProject.name };
        }

        const updated: WorkLog = {
            ...existing,
            ...input.changes,
            ...assignment,
            id: existing.id,
        };
        await db.workLogs.put(updated);
        return updated;
    });
}
