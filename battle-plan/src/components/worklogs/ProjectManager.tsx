import { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Archive, FolderKanban, Plus, RotateCcw } from 'lucide-react';
import { db, type Project, type ProjectColor } from '../../db';
import {
    archiveProject,
    createProject,
    mergeProjects,
    previewProjectMerge,
    restoreProject,
    updateProject,
    type ProjectCatalogResult,
    type ProjectMergePreview,
} from '../../services/projectCatalog';
import { PROJECT_COLOR_DOT, PROJECT_COLOR_OPTIONS } from '../../utils/projectColors';
import { getProjectMergeEligibility, projectMergeErrorMessage } from './projectMergeUi';

interface ProjectManagerProps {
    onMessage?: (message: string, type?: 'info' | 'error') => void;
}

function resultError(result: ProjectCatalogResult): string {
    if (result.outcome === 'duplicate') return `Projekt „${result.project.name}“ už existuje.`;
    if (result.outcome === 'conflict') return 'Existuje více starších projektů se stejným názvem. Změna nebyla provedena.';
    if (result.outcome === 'validation') return result.message;
    return 'Projekt se nepodařilo změnit.';
}

const CATALOG_FAILURE_MESSAGE = 'Projekt se nepodařilo změnit. Zkuste to znovu.';
const MERGE_FAILURE_MESSAGE = 'Sloučení se nepodařilo dokončit. Nic se nezměnilo, zkus to prosím znovu.';

function projectColorLabel(project: Project): string {
    return PROJECT_COLOR_OPTIONS.find((option) => option.value === project.color)?.label ?? project.color;
}

export function ProjectManager({ onMessage }: ProjectManagerProps) {
    const projects = useLiveQuery(() => db.projects.toArray(), []);
    const { activeProjects, archivedProjects } = useMemo(() => {
        const sorted = [...(projects ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'cs'));
        return {
            activeProjects: sorted.filter((project) => project.isActive),
            archivedProjects: sorted.filter((project) => !project.isActive),
        };
    }, [projects]);
    const [name, setName] = useState('');
    const [color, setColor] = useState<ProjectColor>('indigo');
    const [pendingRestore, setPendingRestore] = useState<Project | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [createBusy, setCreateBusy] = useState(false);
    const createBusyRef = useRef(false);
    const [pendingProjectIds, setPendingProjectIds] = useState<Set<number>>(() => new Set());
    const pendingProjectIdsRef = useRef<Set<number>>(new Set());
    const [mergeSourceId, setMergeSourceId] = useState('');
    const [mergeSurvivorId, setMergeSurvivorId] = useState('');
    const [mergePreview, setMergePreview] = useState<ProjectMergePreview | null>(null);
    const [mergeError, setMergeError] = useState<string | null>(null);
    const [mergeBusy, setMergeBusy] = useState(false);
    const mergeBusyRef = useRef(false);
    const mergePreviewHeadingRef = useRef<HTMLHeadingElement>(null);

    const selectedSourceId = mergeSourceId ? Number(mergeSourceId) : undefined;
    const selectedSurvivorId = mergeSurvivorId ? Number(mergeSurvivorId) : undefined;
    const mergeEligibility = useMemo(
        () => getProjectMergeEligibility(projects ?? [], selectedSourceId),
        [projects, selectedSourceId],
    );
    const selectedSourceProject = mergeEligibility.sourceProjects.find((project) => project.id === selectedSourceId);
    const mergeUnavailableReason = mergeEligibility.disabledReason
        ?? (selectedSourceId === undefined ? 'Nejdřív vyber projekt, který chceš sloučit.' : null);

    const showError = (message: string) => {
        setStatus(message);
        onMessage?.(message, 'error');
    };

    const beginCreateOperation = () => {
        if (createBusyRef.current) return false;
        createBusyRef.current = true;
        setCreateBusy(true);
        return true;
    };

    const endCreateOperation = () => {
        createBusyRef.current = false;
        setCreateBusy(false);
    };

    const updatePendingProjectIds = (ids: number[], pending: boolean) => {
        const next = new Set(pendingProjectIdsRef.current);
        for (const id of ids) {
            if (pending) next.add(id);
            else next.delete(id);
        }
        pendingProjectIdsRef.current = next;
        setPendingProjectIds(next);
    };

    const beginProjectOperation = (id: number) => {
        if (pendingProjectIdsRef.current.has(id)) return false;
        updatePendingProjectIds([id], true);
        return true;
    };

    const endProjectOperation = (id: number) => {
        updatePendingProjectIds([id], false);
    };

    const lockMergeProjects = (ids: number[]) => {
        if (mergeBusyRef.current || ids.some((id) => pendingProjectIdsRef.current.has(id))) return false;
        mergeBusyRef.current = true;
        setMergeBusy(true);
        updatePendingProjectIds(ids, true);
        return true;
    };

    const unlockMergeProjects = (ids: number[]) => {
        updatePendingProjectIds(ids, false);
        mergeBusyRef.current = false;
        setMergeBusy(false);
    };

    const clearMergePreview = () => {
        setMergePreview(null);
        setMergeError(null);
    };

    const handleMergeSourceChange = (value: string) => {
        setMergeSourceId(value);
        setMergeSurvivorId('');
        clearMergePreview();
    };

    const handleMergeSurvivorChange = (value: string) => {
        setMergeSurvivorId(value);
        clearMergePreview();
    };

    const handleMergePreview = async () => {
        if (selectedSourceId === undefined || selectedSurvivorId === undefined || mergeBusyRef.current) return;
        mergeBusyRef.current = true;
        setMergeBusy(true);
        setMergeError(null);
        try {
            const result = await previewProjectMerge({
                sourceProjectId: selectedSourceId,
                survivorProjectId: selectedSurvivorId,
            });
            if (result.outcome !== 'ready') {
                setMergePreview(null);
                setMergeError(projectMergeErrorMessage(result));
                return;
            }
            setMergePreview(result.preview);
            requestAnimationFrame(() => mergePreviewHeadingRef.current?.focus());
        } catch {
            setMergePreview(null);
            setMergeError(MERGE_FAILURE_MESSAGE);
        } finally {
            mergeBusyRef.current = false;
            setMergeBusy(false);
        }
    };

    const handleMergeConfirm = async () => {
        const preview = mergePreview;
        const sourceId = preview?.source.id;
        const survivorId = preview?.survivor.id;
        if (!preview || sourceId === undefined || survivorId === undefined) return;
        const lockedIds = [sourceId, survivorId];
        if (!lockMergeProjects(lockedIds)) return;
        setMergeError(null);
        try {
            const result = await mergeProjects({
                sourceProjectId: sourceId,
                survivorProjectId: survivorId,
                previewToken: preview.token,
            });
            if (result.outcome === 'merged') {
                const message = `Projekty byly sloučeny do „${result.project.name}“. Přesunuto pracovních záznamů: ${result.workLogsRelinked}.`;
                setMergeSourceId('');
                setMergeSurvivorId('');
                setMergePreview(null);
                setStatus(message);
                onMessage?.(message, 'info');
                return;
            }

            const error = projectMergeErrorMessage(result);
            setMergeError(error);
            if (result.outcome === 'stale' || result.outcome === 'validation') setMergePreview(null);
            onMessage?.(error, 'error');
        } catch {
            setMergeError(MERGE_FAILURE_MESSAGE);
            onMessage?.(MERGE_FAILURE_MESSAGE, 'error');
        } finally {
            unlockMergeProjects(lockedIds);
        }
    };

    const finishCreate = (project: Project, restored: boolean) => {
        setName('');
        setColor('indigo');
        setPendingRestore(null);
        const message = restored
            ? `Projekt „${project.name}“ byl obnoven.`
            : `Projekt „${project.name}“ byl založen.`;
        setStatus(message);
        onMessage?.(message, 'info');
    };

    const handleCreate = async () => {
        if (!name.trim() || !beginCreateOperation()) return;
        setStatus(null);
        try {
            const result = await createProject({ name, color, source: 'user' });
            if (result.outcome === 'archived-match') {
                setPendingRestore(result.project);
                setStatus(`Projekt „${result.project.name}“ je archivovaný. Obnovit původní projekt?`);
                return;
            }
            if (result.outcome === 'created' || result.outcome === 'restored') {
                finishCreate(result.project, result.outcome === 'restored');
                return;
            }
            showError(resultError(result));
        } catch {
            showError(CATALOG_FAILURE_MESSAGE);
        } finally {
            endCreateOperation();
        }
    };

    const handlePendingRestore = async () => {
        const project = pendingRestore;
        if (!project?.id || createBusyRef.current || pendingProjectIdsRef.current.has(project.id)) return;
        if (!beginCreateOperation()) return;
        if (!beginProjectOperation(project.id)) {
            endCreateOperation();
            return;
        }
        setStatus(null);
        try {
            const result = await restoreProject({
                id: project.id,
                color,
                source: 'user',
            });
            if (result.outcome === 'restored') {
                finishCreate(result.project, true);
                return;
            }
            showError(resultError(result));
        } catch {
            showError(CATALOG_FAILURE_MESSAGE);
        } finally {
            endProjectOperation(project.id);
            endCreateOperation();
        }
    };

    const handleArchive = async (project: Project) => {
        if (!project.id) return;
        const id = project.id;
        if (pendingProjectIdsRef.current.has(id)) return;
        if (!window.confirm(`Archivovat projekt „${project.name}“? Historické pracovní záznamy zůstanou beze změny.`)) return;
        if (!beginProjectOperation(id)) return;
        try {
            const result = await archiveProject({ id, source: 'user' });
            if (result.outcome === 'archived') {
                const message = `Projekt „${project.name}“ byl archivován. Historie zůstala zachována.`;
                setStatus(message);
                onMessage?.(message, 'info');
            } else {
                showError(resultError(result));
            }
        } catch {
            showError(CATALOG_FAILURE_MESSAGE);
        } finally {
            endProjectOperation(id);
        }
    };

    const handleRestore = async (project: Project) => {
        if (!project.id) return;
        const id = project.id;
        if (!beginProjectOperation(id)) return;
        try {
            const result = await restoreProject({ id, source: 'user' });
            if (result.outcome === 'restored') {
                const message = `Projekt „${project.name}“ byl obnoven.`;
                setStatus(message);
                onMessage?.(message, 'info');
            } else {
                showError(resultError(result));
            }
        } catch {
            showError(CATALOG_FAILURE_MESSAGE);
        } finally {
            endProjectOperation(id);
        }
    };

    const handleColor = async (project: Project, nextColor: ProjectColor) => {
        if (!project.id || project.color === nextColor) return;
        const id = project.id;
        if (!beginProjectOperation(id)) return;
        try {
            const result = await updateProject({ id, color: nextColor, source: 'user' });
            if (result.outcome !== 'updated') showError(resultError(result));
        } catch {
            showError(CATALOG_FAILURE_MESSAGE);
        } finally {
            endProjectOperation(id);
        }
    };

    const renderProject = (project: Project, archived: boolean) => {
        const projectBusy = project.id !== undefined && pendingProjectIds.has(project.id);
        return (
            <li
            key={project.id}
            className="flex min-w-0 flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3 sm:flex-row sm:items-center"
        >
            <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className={`h-3 w-3 shrink-0 rounded-full ${PROJECT_COLOR_DOT[project.color]}`} aria-hidden="true" />
                <span className="truncate text-sm font-bold text-white">{project.name}</span>
                <span className="sr-only">Barva: {projectColorLabel(project)}</span>
            </div>
            <div className="flex w-full items-center gap-2 sm:w-auto">
                <label className="sr-only" htmlFor={`project-color-${project.id}`}>Barva projektu {project.name}</label>
                <select
                    id={`project-color-${project.id}`}
                    value={project.color}
                    onChange={(event) => void handleColor(project, event.target.value as ProjectColor)}
                    disabled={projectBusy}
                    className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-xs font-bold text-slate-200 outline-none focus:border-indigo-500 sm:w-32"
                >
                    {PROJECT_COLOR_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                {archived ? (
                    <button
                        type="button"
                        onClick={() => void handleRestore(project)}
                        disabled={projectBusy}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-500/40 px-3 py-2 text-xs font-black uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                    >
                        <RotateCcw className="h-3.5 w-3.5" /> Obnovit
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => void handleArchive(project)}
                        disabled={projectBusy}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-black uppercase tracking-wider text-slate-400 hover:border-amber-500/50 hover:text-amber-300 disabled:opacity-50"
                    >
                        <Archive className="h-3.5 w-3.5" /> Archivovat
                    </button>
                )}
            </div>
            </li>
        );
    };

    return (
        <section aria-labelledby="project-manager-title" className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
            <div className="mb-4 flex items-start gap-3">
                <div className="rounded-xl bg-indigo-500/10 p-2 text-indigo-300"><FolderKanban className="h-5 w-5" /></div>
                <div>
                    <h3 id="project-manager-title" className="text-sm font-black uppercase tracking-widest text-white">Projekty</h3>
                    <p className="mt-1 text-xs text-slate-500">Projekt založ jednou a potom ho vybírej u všech pracovních záznamů.</p>
                </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto]">
                <label className="min-w-0">
                    <span className="sr-only">Název nového projektu</span>
                    <input
                        value={name}
                        onChange={(event) => { setName(event.target.value); setPendingRestore(null); setStatus(null); }}
                        onKeyDown={(event) => { if (event.key === 'Enter') void handleCreate(); }}
                        disabled={createBusy}
                        placeholder="Např. Liberec Plaza Banka"
                        className="w-full rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-600 focus:border-indigo-500 disabled:opacity-50"
                    />
                </label>
                <label>
                    <span className="sr-only">Barva nového projektu</span>
                    <select
                        value={color}
                        onChange={(event) => setColor(event.target.value as ProjectColor)}
                        disabled={createBusy}
                        className="w-full rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2.5 text-sm font-bold text-slate-200 outline-none focus:border-indigo-500 disabled:opacity-50"
                    >
                        {PROJECT_COLOR_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                </label>
                <button
                    type="button"
                    onClick={() => void handleCreate()}
                    disabled={!name.trim() || createBusy}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-black uppercase tracking-widest text-white hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600"
                >
                    <Plus className="h-4 w-4" /> Založit
                </button>
            </div>

            {pendingRestore && (
                <div className="mt-3 flex flex-col gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100 sm:flex-row sm:items-center sm:justify-between">
                    <span>Projekt „{pendingRestore.name}“ už je v archivu. Obnovit původní projekt se stejnou historií?</span>
                    <button
                        type="button"
                        onClick={() => void handlePendingRestore()}
                        disabled={createBusy || (pendingRestore.id !== undefined && pendingProjectIds.has(pendingRestore.id))}
                        className="shrink-0 rounded-lg bg-amber-500/20 px-3 py-2 font-black uppercase tracking-wider hover:bg-amber-500/30 disabled:opacity-50"
                    >
                        Obnovit původní
                    </button>
                </div>
            )}
            {status && <p role="status" className="mt-3 text-xs text-slate-300">{status}</p>}

            <div className="mt-5 grid gap-5 lg:grid-cols-2">
                <div>
                    <h4 className="mb-2 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Aktivní ({activeProjects.length})</h4>
                    {activeProjects.length === 0
                        ? <p className="rounded-xl border border-dashed border-slate-800 p-4 text-center text-xs text-slate-600">Zatím žádný aktivní projekt.</p>
                        : <ul className="space-y-2">{activeProjects.map((project) => renderProject(project, false))}</ul>}
                </div>
                <div>
                    <h4 className="mb-2 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Archivované ({archivedProjects.length})</h4>
                    {archivedProjects.length === 0
                        ? <p className="rounded-xl border border-dashed border-slate-800 p-4 text-center text-xs text-slate-600">Archiv je prázdný.</p>
                        : <ul className="space-y-2">{archivedProjects.map((project) => renderProject(project, true))}</ul>}
                </div>
            </div>

            <div className="mt-6 border-t border-slate-800 pt-5">
                <div className="mb-3">
                    <h4 id="project-merge-title" className="text-xs font-black uppercase tracking-[0.18em] text-white">Sloučit projekty</h4>
                    <p id="project-merge-help" className="mt-1 text-xs leading-relaxed text-slate-500">
                        Přesuň všechny pracovní záznamy z chybně zdvojeného projektu do jednoho aktivního projektu.
                    </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="min-w-0 text-xs font-bold text-slate-300" htmlFor="project-merge-source">
                        Převést z
                        <select
                            id="project-merge-source"
                            value={mergeSourceId}
                            onChange={(event) => handleMergeSourceChange(event.target.value)}
                            disabled={mergeBusy || mergeEligibility.sourceProjects.length < 2}
                            aria-describedby={mergeError ? 'project-merge-error project-merge-help' : 'project-merge-help'}
                            className="mt-1.5 w-full min-w-0 rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2.5 text-sm font-bold text-white outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <option value="">Vyber zdrojový projekt</option>
                            {mergeEligibility.sourceProjects.map((project) => (
                                <option key={project.id} value={project.id}>
                                    {project.name} — {project.isActive ? 'aktivní' : 'archivovaný'}
                                </option>
                            ))}
                        </select>
                        {selectedSourceProject && (
                            <span className={`mt-1.5 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${selectedSourceProject.isActive ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>
                                {selectedSourceProject.isActive ? 'Aktivní zdroj' : 'Archivovaný zdroj'}
                            </span>
                        )}
                    </label>

                    <label className="min-w-0 text-xs font-bold text-slate-300" htmlFor="project-merge-survivor">
                        Sloučit do (tento projekt zůstane)
                        <select
                            id="project-merge-survivor"
                            value={mergeSurvivorId}
                            onChange={(event) => handleMergeSurvivorChange(event.target.value)}
                            disabled={mergeBusy || selectedSourceId === undefined || mergeEligibility.survivorProjects.length === 0}
                            aria-describedby={mergeError ? 'project-merge-error project-merge-help' : 'project-merge-help'}
                            className="mt-1.5 w-full min-w-0 rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2.5 text-sm font-bold text-white outline-none focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <option value="">Vyber aktivní cílový projekt</option>
                            {mergeEligibility.survivorProjects.map((project) => (
                                <option key={project.id} value={project.id}>{project.name} — aktivní</option>
                            ))}
                        </select>
                    </label>
                </div>

                {mergeUnavailableReason && !mergePreview && (
                    <p className="mt-2 text-xs text-slate-500">{mergeUnavailableReason}</p>
                )}

                {mergeError && (
                    <p id="project-merge-error" role="alert" className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs leading-relaxed text-rose-200">
                        {mergeError}
                    </p>
                )}

                {!mergePreview && (
                    <button
                        type="button"
                        onClick={() => void handleMergePreview()}
                        disabled={mergeBusy || selectedSourceId === undefined || selectedSurvivorId === undefined || mergeEligibility.disabledReason !== null}
                        className="mt-3 inline-flex w-full items-center justify-center rounded-xl border border-indigo-500/40 bg-indigo-500/10 px-4 py-2.5 text-xs font-black uppercase tracking-wider text-indigo-200 hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-600 sm:w-auto"
                    >
                        Zkontrolovat sloučení
                    </button>
                )}

                {mergePreview && (
                    <div
                        role="region"
                        aria-labelledby="project-merge-preview-title"
                        aria-live="polite"
                        aria-atomic="true"
                        className="mt-4 rounded-xl border border-amber-500/35 bg-amber-500/10 p-4"
                    >
                        <h5
                            ref={mergePreviewHeadingRef}
                            id="project-merge-preview-title"
                            tabIndex={-1}
                            className="text-sm font-black text-amber-100 outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                        >
                            Zkontroluj směr sloučení
                        </h5>

                        <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-stretch">
                            <div className="min-w-0 rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                                <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Tento projekt zanikne</p>
                                <p className="mt-1 break-words text-sm font-black text-white">{mergePreview.source.name}</p>
                                <p className="mt-2 text-xs leading-relaxed text-slate-300">
                                    Stav: {mergePreview.source.isActive ? 'aktivní' : 'archivovaný'}<br />
                                    Barva: {projectColorLabel(mergePreview.source)}
                                </p>
                            </div>

                            <div aria-hidden="true" className="flex items-center justify-center text-center text-lg font-black text-amber-300">
                                <span className="sm:hidden">↓</span><span className="hidden sm:inline">→</span>
                            </div>

                            <div className="min-w-0 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
                                <p className="text-[10px] font-black uppercase tracking-wider text-emerald-300">Tento projekt zůstane</p>
                                <p className="mt-1 break-words text-sm font-black text-white">{mergePreview.survivor.name}</p>
                                <p className="mt-2 text-xs leading-relaxed text-slate-200">
                                    Stav: aktivní<br />
                                    Barva: {projectColorLabel(mergePreview.survivor)}
                                </p>
                            </div>
                        </div>

                        <dl className="mt-3 grid gap-2 rounded-lg border border-amber-500/20 bg-slate-950/30 p-3 text-xs sm:grid-cols-3">
                            <div>
                                <dt className="text-slate-400">Přesune se</dt>
                                <dd className="mt-0.5 text-base font-black text-white">{mergePreview.sourceWorkLogCount}</dd>
                                <dd className="text-slate-400">pracovních záznamů</dd>
                            </div>
                            <div>
                                <dt className="text-slate-400">V cíli už je</dt>
                                <dd className="mt-0.5 text-base font-black text-white">{mergePreview.survivorWorkLogCount}</dd>
                                <dd className="text-slate-400">pracovních záznamů</dd>
                            </div>
                            <div>
                                <dt className="text-slate-400">Po sloučení celkem</dt>
                                <dd className="mt-0.5 text-base font-black text-emerald-300">
                                    {mergePreview.sourceWorkLogCount + mergePreview.survivorWorkLogCount}
                                </dd>
                                <dd className="text-slate-400">pracovních záznamů</dd>
                            </div>
                        </dl>

                        <p className="mt-3 text-xs font-bold leading-relaxed text-amber-100">
                            Název, barva a aktivní stav projektu „{mergePreview.survivor.name}“ zůstanou zachované. Tuto akci zatím nelze vrátit zpět.
                        </p>

                        <div className="mt-4 grid gap-2 sm:flex sm:justify-end">
                            <button
                                type="button"
                                onClick={clearMergePreview}
                                disabled={mergeBusy}
                                className="order-2 rounded-lg border border-slate-600 px-4 py-2.5 text-xs font-black uppercase tracking-wider text-slate-200 hover:bg-slate-800 disabled:opacity-50 sm:order-1"
                            >
                                Zrušit
                            </button>
                            <button
                                type="button"
                                onClick={() => void handleMergeConfirm()}
                                disabled={mergeBusy}
                                className="order-1 rounded-lg bg-rose-600 px-4 py-2.5 text-xs font-black uppercase tracking-wider text-white hover:bg-rose-500 disabled:cursor-wait disabled:opacity-50 sm:order-2"
                            >
                                {mergeBusy ? 'Slučuji…' : `Sloučit do „${mergePreview.survivor.name}“`}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
}
