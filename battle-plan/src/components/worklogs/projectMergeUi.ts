import type { Project } from '../../db.ts';
import type { ProjectMergePreviewResult, ProjectMergeResult } from '../../services/projectCatalog.ts';

type ProjectMergeFailure =
    | Exclude<ProjectMergePreviewResult, { outcome: 'ready' }>
    | Exclude<ProjectMergeResult, { outcome: 'merged' }>;

export interface ProjectMergeEligibility {
    sourceProjects: Project[];
    survivorProjects: Project[];
    disabledReason: string | null;
}

export function getProjectMergeEligibility(
    projects: Project[],
    sourceProjectId?: number,
): ProjectMergeEligibility {
    const sourceProjects = [...projects].sort((left, right) => left.name.localeCompare(right.name, 'cs'));
    const survivorProjects = sourceProjects.filter(
        (project) => project.isActive && project.id !== sourceProjectId,
    );

    let disabledReason: string | null = null;
    if (sourceProjects.length < 2) {
        disabledReason = 'Ke sloučení jsou potřeba alespoň dva projekty.';
    } else if (survivorProjects.length === 0) {
        disabledReason = 'Nejdřív obnov alespoň jeden jiný projekt, který má po sloučení zůstat aktivní.';
    }

    return { sourceProjects, survivorProjects, disabledReason };
}

export function projectMergeErrorMessage(result: ProjectMergeFailure): string {
    if (result.outcome === 'stale') {
        return 'Vybrané projekty se od náhledu změnily. Zkontroluj je a vytvoř nový náhled sloučení.';
    }
    if (result.outcome === 'conflict') {
        const names = result.projects.map((project) => `„${project.name}“`).join(', ');
        return `Sloučení blokuje konflikt identity s ${result.projects.length === 1 ? 'projektem' : 'projekty'} ${names}. Nic se nezměnilo.`;
    }

    switch (result.message) {
        case 'source project not found':
            return 'Zdrojový projekt už neexistuje. Vyber jiný projekt a vytvoř nový náhled.';
        case 'survivor project not found':
            return 'Cílový projekt už neexistuje. Vyber jiný aktivní projekt a vytvoř nový náhled.';
        case 'survivor project must be active':
            return 'Cílový projekt musí být aktivní. Obnov ho, nebo vyber jiný aktivní projekt.';
        case 'source and survivor must be different projects':
            return 'Zdrojový a cílový projekt musí být různé.';
        case 'merge preview required':
            return 'Před sloučením nejdřív vytvoř nový náhled.';
        default:
            return 'Sloučení se nepodařilo ověřit. Zkontroluj výběr a zkus to znovu.';
    }
}
