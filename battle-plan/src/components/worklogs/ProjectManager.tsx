import { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Archive, FolderKanban, Plus, RotateCcw } from 'lucide-react';
import { db, type Project, type ProjectColor } from '../../db';
import {
    archiveProject,
    createProject,
    restoreProject,
    updateProject,
    type ProjectCatalogResult,
} from '../../services/projectCatalog';
import { PROJECT_COLOR_DOT, PROJECT_COLOR_OPTIONS } from '../../utils/projectColors';

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

    const beginProjectOperation = (id: number) => {
        if (pendingProjectIdsRef.current.has(id)) return false;
        const next = new Set(pendingProjectIdsRef.current);
        next.add(id);
        pendingProjectIdsRef.current = next;
        setPendingProjectIds(next);
        return true;
    };

    const endProjectOperation = (id: number) => {
        const next = new Set(pendingProjectIdsRef.current);
        next.delete(id);
        pendingProjectIdsRef.current = next;
        setPendingProjectIds(next);
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
                <span className="sr-only">Barva: {PROJECT_COLOR_OPTIONS.find((item) => item.value === project.color)?.label}</span>
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
        </section>
    );
}
