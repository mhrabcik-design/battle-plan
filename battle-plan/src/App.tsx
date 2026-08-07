import { lazy, Suspense, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Mic, MicOff, AlertCircle, List, Users, Lightbulb, Clock, Settings, ChevronLeft, ChevronRight, LayoutGrid, CheckCircle2, Inbox, Briefcase, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAudioRecorder } from './hooks/useAudioRecorder';
import { useSyncDiagnostics } from './hooks/useSyncDiagnostics';
import { useDriveSyncOrchestration } from './hooks/useDriveSyncOrchestration';
import { useSuggestionsBadge } from './hooks/useSuggestionsBadge';
import { useAgentBridgePolling } from './hooks/useAgentBridgePolling';
import { useTaskCommands } from './hooks/useTaskCommands';
import { useGlobalVoiceProcessing } from './hooks/useGlobalVoiceProcessing';
import { db, type Task } from './db';
import { useLiveQuery } from 'dexie-react-hooks';
import { AVAILABLE_GEMINI_MODELS, DEFAULT_GEMINI_MODEL, geminiService } from './services/geminiService';
import { googleService } from './services/googleService';
import { taskDriveBackup } from './services/taskDriveBackup';
import { mergeLocalToCloud } from './services/workLogsSync';
import type { ViewMode, UnifiedTask, GoogleAuthStatus, GoogleTaskList, GoogleTaskRaw } from './types';
import { hasUsableAuth as checkUsableAuth, isAuthUnavailable } from './types';
import { Sidebar } from './components/Sidebar';
import { syncIconFor } from './components/syncIcon';
import { TaskCard } from './components/TaskCard';
import { FocusEditor } from './components/FocusEditor';
import { SettingsModal } from './components/SettingsModal';
import { OnboardingCard } from './components/OnboardingCard';
import { SlashCommandPalette } from './components/SlashCommandPalette';
import { dismissOnboarding, isOnboardingDismissed } from './services/onboarding';
import { WeeklyCalendar } from './components/WeeklyCalendar';
import type { WorkLogVoiceController } from './components/worklogs/WorkLogVoiceBar';
import type { ExtractedWorkLogBatch } from './services/workLogExtractor';
import { WorkLogVoiceConfirm } from './components/worklogs/WorkLogVoiceConfirm';
import {
  formatTimeLeft,
  getDeadlineColor,
  isOverCapacity,
  getWeekDays,
  getUrgencyColor
} from './utils/calendarUtils';
import { buildInfo } from './utils/buildInfo';
import { getErrorMessage } from './utils/errors';

const SuggestionsPage = lazy(() => import('./pages/SuggestionsPage').then((module) => ({ default: module.SuggestionsPage })));
const WorkLogsPage = lazy(() => import('./pages/WorkLogsPage').then((module) => ({ default: module.WorkLogsPage })));
const DiagnosticsPage = lazy(() => import('./pages/DiagnosticsPage').then((module) => ({ default: module.DiagnosticsPage })));

const AVAILABLE_MODELS = AVAILABLE_GEMINI_MODELS;

const NAV_ITEMS = [
  { id: 'battle', label: 'Plán', icon: List },
  { id: 'week', label: 'Týden', icon: LayoutGrid },
  { id: 'tasks', label: 'Úkoly', icon: CheckCircle2 },
  { id: 'meetings', label: 'Schůzky', icon: Users },
  { id: 'worklogs', label: 'Práce', icon: Briefcase },
  { id: 'thoughts', label: 'Myšlenky', icon: Lightbulb },
  { id: 'suggestions', label: 'Návrhy', icon: Inbox },
];

const ROW_HEIGHT = 80;
const CALENDAR_HOURS = Array.from({ length: 13 }, (_, i) => i + 7);
const TASK_GRID_VIEW_MODES: ViewMode[] = ['battle', 'tasks', 'meetings', 'thoughts'];
const TASK_QUERY_VIEW_MODES: ViewMode[] = [...TASK_GRID_VIEW_MODES, 'week'];
const EMPTY_TASKS: Task[] = [];

const pageFallback = (
  <div className="p-12 text-center text-slate-600 text-xs font-black uppercase tracking-widest">
    Načítám obrazovku…
  </div>
);

function App() {
  const { isRecording, startRecording, stopRecording, audioBlob, clearAudio } = useAudioRecorder();
  const [viewMode, setViewMode] = useState<ViewMode>('battle');
  const [editingTask, setEditingTask] = useState<UnifiedTask | null>(null);
  const [activeVoiceUpdateId, setActiveVoiceUpdateId] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState(DEFAULT_GEMINI_MODEL);
  const [googleAuth, setGoogleAuth] = useState<GoogleAuthStatus>({ state: 'SIGNED_OUT', accessToken: null });
  const [weekOffset, setWeekOffset] = useState(0);
  const [lastSync, setLastSync] = useState<string | null>(localStorage.getItem('last_drive_sync'));
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [uiScale, setUiScale] = useState<number>(Number(localStorage.getItem('ui_scale')) || 16);
  const [googleTaskLists, setGoogleTaskLists] = useState<GoogleTaskList[]>([]);
  const [activeTaskList, setActiveTaskList] = useState<string>('@default');
  const [googleTasksRaw, setGoogleTasksRaw] = useState<GoogleTaskRaw[]>([]);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [debugLogs, setDebugLogs] = useState<{ t: string; m: string; type: 'info' | 'error' }[]>([]);
  const [suggestionsBadge, setSuggestionsBadge] = useState(0);
  const [workLogExtracted, setWorkLogExtracted] = useState<ExtractedWorkLogBatch | null>(null);
  const [workLogVoiceController, setWorkLogVoiceController] = useState<WorkLogVoiceController | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const { syncHealth, updateSyncHealth } = useSyncDiagnostics();
  const activeVoiceUpdateIdRef = useRef<number | null>(null);
  const isProcessingRef = useRef(false);

  const addLog = useCallback((message: string, type: 'info' | 'error' = 'info') => {
    const time = new Date().toLocaleTimeString('cs-CZ');
    setDebugLogs(prev => [{ t: time, m: message, type }, ...prev].slice(0, 50));
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (googleAuth.state !== 'SIGNED_IN' && googleAuth.state !== 'REFRESH_PENDING') return;
    isOnboardingDismissed().then((dismissed) => {
      if (!cancelled) setShowOnboarding(!dismissed);
    });
    return () => {
      cancelled = true;
    };
  }, [googleAuth.state]);

  const handleDismissOnboarding = useCallback(async () => {
    await dismissOnboarding();
    setShowOnboarding(false);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const currentHourPosition = useMemo(() => {
    const hours = currentTime.getHours();
    const minutes = currentTime.getMinutes();
    if (hours < 7 || hours >= 20) return -1;
    const totalMinutes = (hours - 7) * 60 + minutes;
    return (totalMinutes / 60) * ROW_HEIGHT;
  }, [currentTime]);

  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${uiScale}px`);
    db.settings.put({ id: 'ui_scale', value: uiScale.toString() });
  }, [uiScale]);

  useEffect(() => {
    document.querySelector('main')?.scrollTo(0, 0);
  }, [viewMode]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const isAiActive = !!apiKey && isOnline;
const hasUsableAuth = checkUsableAuth(googleAuth);
const syncVisualState: 'ok' | 'pending' | 'failed' = useMemo(() => {
    if (isAuthUnavailable(googleAuth.state)) {
        return 'failed';
    }
    const healthValues = Object.values(syncHealth);
    if (healthValues.some(h => h.state === 'error')) {
        return 'failed';
    }
    if (
        googleAuth.state === 'REFRESH_PENDING' ||
        isProcessing ||
        healthValues.some(h => h.state === 'idle' || h.state === 'stale')
    ) {
        return 'pending';
    }
    return 'ok';
}, [googleAuth.state, syncHealth, isProcessing]);

  useEffect(() => {
    const cleanup = async () => {
      try {
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        const toDelete = await db.tasks
          .filter(t => (t.status === 'completed' || !!t.isDeleted) && (t.updatedAt || t.createdAt) < thirtyDaysAgo)
          .primaryKeys();
        if (toDelete.length > 0) {
          await db.tasks.bulkDelete(toDelete);
        }
      } catch (e) {
        console.error("Cleanup failed", e);
      }
    };
    cleanup();
  }, []);

  useEffect(() => {
    const initGoogle = async () => {
      try {
        await googleService.init();
        let status = googleService.getAuthStatus();

        // U6: route the init-time silent refresh through the same single-
        // flight wrapper as runRefresh. A concurrent ensureFreshToken from
        // the public methods shares the same in-flight promise instead of
        // firing a second GIS prompt.
        if (status.state === 'REFRESH_PENDING') {
          await googleService.runRefresh();
          status = googleService.getAuthStatus();
        }

        setGoogleAuth(status);
        const isAuthed = status.state === 'SIGNED_IN' || status.state === 'REFRESH_PENDING';
        updateSyncHealth('google', {
          state: isAuthed ? 'ok' : 'idle',
          detail: isAuthed ? 'Přihlášeno ke Google službám' : 'Nepřihlášeno',
          lastSuccess: isAuthed ? new Date().toLocaleString('cs-CZ') : null,
          lastError: null,
        });
      } catch (e) {
        console.error("Google init failed", e);
        updateSyncHealth('google', {
          state: 'error',
          detail: 'Google inicializace selhala',
          lastError: getErrorMessage(e),
        });
      }
    };
    initGoogle();

    const handleAuthChange = (e: Event) => {
      const detail = (e as CustomEvent<GoogleAuthStatus | null>).detail;
      const authState = detail ?? { state: 'SIGNED_OUT', accessToken: null };
      const isUsable = checkUsableAuth(authState);
      setGoogleAuth(authState);
      updateSyncHealth('google', {
        state: isUsable ? 'ok' : 'idle',
        detail: isUsable ? 'Přihlášeno ke Google službám' : 'Odpojeno od Google služeb',
        lastSuccess: isUsable ? new Date().toLocaleString('cs-CZ') : null,
        lastError: null,
      });
    };
    window.addEventListener('google-auth-change', handleAuthChange);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setEditingTask(null);
        setShowSettings(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('google-auth-change', handleAuthChange);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [updateSyncHealth]);


  const localTasks = useLiveQuery(async () => {
    if (!TASK_QUERY_VIEW_MODES.includes(viewMode)) {
      return [];
    }

    if (viewMode === 'battle') {
      return await db.tasks
        .where('status').equals('pending')
        .and(t => t.type !== 'thought' && t.type !== 'note' && !t.isDeleted)
        .toArray();
    }

    if (viewMode === 'week') {
      const days = getWeekDays(weekOffset);
      const start = days[0].full;
      const end = days[6].full;
      const all = await db.tasks
        .where('deadline').between(start, end, true, true)
        .or('date').between(start, end, true, true)
        .filter(t => !t.isDeleted)
        .toArray();

      // Pivot: Tasks only by deadline, Meetings by date/startTime
      return all.filter(t => {
        if (t.status === 'completed' || t.type === 'thought' || t.type === 'note') return false;
        // Strict deadline policy for duplication removal
        if (t.type === 'task') return t.deadline && t.deadline >= start && t.deadline <= end;
        return t.date && t.date >= start && t.date <= end;
      });
    }

    let collection;
    if (viewMode === 'tasks') collection = db.tasks.where('type').equals('task').and(t => !t.isDeleted);
    else if (viewMode === 'meetings') collection = db.tasks.where('type').equals('meeting').and(t => !t.isDeleted);
    else collection = db.tasks.where('type').anyOf(['thought', 'note']).and(t => !t.isDeleted);

    const all = await collection.toArray();
    return all.sort((a, b) => {
      if (a.status === b.status) return (b.urgency || 0) - (a.urgency || 0);
      return a.status === 'completed' ? 1 : -1;
    });
  }, [viewMode, weekOffset]) ?? EMPTY_TASKS;

  // Mapped Google Tasks
  const googleTasksMapped: UnifiedTask[] = useMemo(() => {
    if (!hasUsableAuth || (viewMode !== 'tasks' && viewMode !== 'battle' && viewMode !== 'week')) return [];

    return googleTasksRaw.map(gt => ({
      title: gt.title,
      description: gt.notes || '',
      status: gt.status === 'completed' ? 'completed' : 'pending',
      type: 'task',
      date: gt.due ? gt.due.split('T')[0] : undefined,
      deadline: gt.due ? gt.due.split('T')[0] : undefined,
      urgency: 3,
      createdAt: new Date(gt.updated).getTime(),
      isGoogleTask: true,
      googleId: gt.id,
      googleListId: activeTaskList,
      updatedAt: new Date(gt.updated).getTime()
    }));
  }, [googleTasksRaw, hasUsableAuth, viewMode, activeTaskList]);

  const tasks: UnifiedTask[] = useMemo(() => {
    const combined = [...localTasks, ...googleTasksMapped];

    if (viewMode === 'battle' || viewMode === 'week') {
      return combined.sort((a, b) => {
        const dateA = a.deadline || a.date || '9999-12-31';
        const dateB = b.deadline || b.date || '9999-12-31';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        const timeA = a.startTime || '15:00';
        const timeB = b.startTime || '15:00';
        if (timeA !== timeB) return timeA.localeCompare(timeB);
        return (b.urgency || 0) - (a.urgency || 0);
      });
    }

    return combined.sort((a, b) => {
      if (a.status === b.status) return (b.urgency || 0) - (a.urgency || 0);
      return a.status === 'completed' ? 1 : -1;
    });
  }, [localTasks, googleTasksMapped, viewMode]);

  useDriveSyncOrchestration({
    googleAuth,
    setGoogleAuth,
    setGoogleTaskLists,
    setApiKey,
    setSelectedModel,
    setUiScale,
    setLastSync,
    addLog,
    updateSyncHealth,
  });

  useSuggestionsBadge({ googleAuth, setSuggestionsBadge, updateSyncHealth, addLog });
  useAgentBridgePolling({ googleAuth, addLog });

  useEffect(() => {
    if (hasUsableAuth && viewMode === 'tasks') {
      googleService.getTasks(activeTaskList).then(setGoogleTasksRaw);
    }
  }, [hasUsableAuth, viewMode, activeTaskList]);

  const tasksHash = useMemo(() => tasks.length * 1000000 + tasks.reduce((sum, t) => sum + (t.updatedAt || 0), 0), [tasks]);

  const workLogsDataHash = useLiveQuery(async () => {
    const [allWorkLogs, allProjects] = await Promise.all([
      db.workLogs.toArray(),
      db.projects.toArray(),
    ]);
    return allWorkLogs.length * 1_000_000 + allWorkLogs.reduce((sum, workLog) => sum + (workLog.updatedAt || 0), 0)
      + allProjects.length * 10_000 + allProjects.reduce((sum, project) => sum + (project.updatedAt || 0), 0);
  }, []) ?? 0;

  // Auto-backup on change
  useEffect(() => {
    if (!hasUsableAuth) return;

    const timer = setTimeout(async () => {
      try {
        const allTasks = await db.tasks.toArray();
        const allSettings = await db.settings.toArray();
        const savedTimestamp = await taskDriveBackup.save({ tasks: allTasks, settings: allSettings });

        if (savedTimestamp) {
          const now = new Date().toLocaleString('cs-CZ');
          setLastSync(now);
          localStorage.setItem('last_drive_sync', now);
          localStorage.setItem('last_drive_sync_ts', savedTimestamp.toString());
          updateSyncHealth('tasks', {
            state: 'ok',
            detail: 'Automatická záloha na Disk úspěšná',
            lastSuccess: now,
            lastError: null,
          });
          addLog('Automatická záloha na Disk úspěšná');
        }
      } catch (e) {
        console.error('Auto-backup failed', e);
        updateSyncHealth('tasks', {
          state: 'error',
          detail: 'Automatická záloha na Disk selhala',
          lastError: getErrorMessage(e),
        });
      }
    }, 10000);

    return () => clearTimeout(timer);
  }, [tasksHash, hasUsableAuth, addLog, updateSyncHealth]);

  useEffect(() => {
    if (!hasUsableAuth || workLogsDataHash === 0) return;

    const timer = setTimeout(async () => {
      try {
        const ok = await mergeLocalToCloud();
        if (ok) {
          updateSyncHealth('worklogs', {
            state: 'ok',
            detail: 'WorkLogs záloha na Disk úspěšná',
            lastSuccess: new Date().toLocaleString('cs-CZ'),
            lastError: null,
          });
          addLog('WorkLogs záloha na Disk úspěšná', 'info');
        } else {
          updateSyncHealth('worklogs', {
            state: 'stale',
            detail: 'WorkLogs záloha nebyla provedena',
          });
        }
      } catch (e) {
        console.error('WorkLogs auto-backup failed', e);
        updateSyncHealth('worklogs', {
          state: 'error',
          detail: 'WorkLogs záloha na Disk selhala',
          lastError: getErrorMessage(e),
        });
      }
    }, 10000);

    return () => clearTimeout(timer);
  }, [workLogsDataHash, hasUsableAuth, addLog, updateSyncHealth]);

  useEffect(() => {
    db.settings.get('gemini_api_key').then(setting => {
      if (setting) setApiKey(setting.value);
    });
    db.settings.get('gemini_model').then(setting => {
      if (setting) {
        const isValid = AVAILABLE_MODELS.includes(setting.value);
        if (isValid) {
          setSelectedModel(setting.value);
        } else {
          setSelectedModel(DEFAULT_GEMINI_MODEL);
          db.settings.put({ id: 'gemini_model', value: DEFAULT_GEMINI_MODEL });
        }
      }
    });
    db.settings.get('ui_scale').then(setting => {
      if (setting) setUiScale(Number(setting.value));
    });
  }, []);


  const saveSettings = async () => {
    await db.settings.put({ id: 'gemini_api_key', value: apiKey });
    await db.settings.put({ id: 'gemini_model', value: selectedModel });
    setShowSettings(false);
    geminiService.clearModelCache();
    await geminiService.init();
  };

  const {
    applyAiResult,
    toggleSubtask,
    handleToggleTask,
    handleDeleteTask,
    handleSaveEdit,
    handleSyncToGoogle,
    handleExport,
  } = useTaskCommands({
    googleAuth,
    activeTaskList,
    editingTask,
    setEditingTask,
    setGoogleTasksRaw,
    setIsProcessing,
  });

  useGlobalVoiceProcessing({
    audioBlob,
    viewMode,
    selectedModel,
    activeVoiceUpdateIdRef,
    isProcessingRef,
    setIsProcessing,
    setActiveVoiceUpdateId,
    setWorkLogExtracted,
    clearAudio,
    addLog,
    applyAiResult,
  });

  const memoizedIsOverCapacity = useCallback((task: UnifiedTask) => isOverCapacity(currentTime, task), [currentTime]);
  const memoizedGetDeadlineColor = useCallback((date?: string, time?: string) => getDeadlineColor(currentTime, date, time), [currentTime]);
  const memoizedFormatTimeLeft = useCallback((date?: string, time?: string) => formatTimeLeft(currentTime, date, time), [currentTime]);
  const showTaskGrid = TASK_GRID_VIEW_MODES.includes(viewMode);
  const activeWorkLogVoiceController = viewMode === 'worklogs' ? workLogVoiceController : null;
  const isWorkLogVoiceMode = !!activeWorkLogVoiceController;
  const floatingMicIsRecording = activeWorkLogVoiceController?.isRecording ?? isRecording;
  const floatingMicIsProcessing = activeWorkLogVoiceController?.processing ?? isProcessing;
  const floatingMicDisabled = activeWorkLogVoiceController?.disabled ?? isProcessing;

  return (
    <div className="flex h-screen bg-slate-950 overflow-hidden font-body text-slate-200">
      <Sidebar
        viewMode={viewMode}
        setViewMode={setViewMode}
        isAiActive={isAiActive}
        navItems={NAV_ITEMS}
        setShowSettings={setShowSettings}
        isProcessing={isProcessing}
        suggestionsBadge={suggestionsBadge}
        appVersion={buildInfo.version}
        syncState={syncVisualState}
      />

      {/* MAIN CONTENT AREA */}
      <main className={`flex-1 relative ${viewMode === 'week' ? 'overflow-hidden' : 'overflow-y-auto'} overflow-x-hidden flex flex-col no-scrollbar bg-slate-950`}>
        <div className={`w-full h-full flex flex-col ${viewMode === 'week' ? 'px-0 py-0 max-w-full' : 'px-4 md:px-8 lg:px-10 py-6 md:py-8 max-w-[1600px] mx-auto'} ${viewMode === 'week' ? 'pb-0' : 'pb-32 md:pb-12'}`}>

          <header className={`hidden md:flex flex-col gap-1 border-b border-slate-900 ${viewMode === 'week' ? 'mb-0 pb-0 pt-4 px-6 md:px-10' : 'mb-6 pb-4'}`}>
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-black text-white uppercase tracking-tight">
                  {NAV_ITEMS.find(i => i.id === viewMode)?.label || 'Plán'}
                </h1>
                <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-1">
                  {viewMode === 'battle' ? 'Strategický přehled dne' :
                    viewMode === 'week' ? 'Plánování týdenních cílů' :
                      viewMode === 'suggestions' ? 'Návrhy od Anu ke schválení' :
                        viewMode === 'worklogs' ? 'Večerní diktování pracovních činností' :
                          'Správa pracovního workflow'}
                </p>
              </div>

              {viewMode === 'week' && (
                <div className="flex items-center gap-4 bg-slate-900/40 px-4 py-1.5 rounded-xl border border-slate-800/60">
                  <h2 className="text-sm font-black text-white uppercase tracking-[0.2em]">
                    {new Date(getWeekDays(weekOffset)[0].full).toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' })}
                  </h2>
                  <div className="flex gap-1.5 border-l border-slate-800 ml-2 pl-4">
                    <button onClick={() => setWeekOffset(prev => prev - 1)} className="p-1.5 rounded-lg bg-slate-800/50 text-slate-400 hover:text-white transition-all border border-slate-700/50"><ChevronLeft className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setWeekOffset(0)} className="px-3 py-1.5 rounded-lg bg-slate-800/50 text-xs font-black text-white uppercase tracking-widest hover:bg-slate-700 transition-all border border-slate-700/50">Dnes</button>
                    <button onClick={() => setWeekOffset(prev => prev + 1)} className="p-1.5 rounded-lg bg-slate-800/50 text-slate-400 hover:text-white transition-all border border-slate-700/50"><ChevronRight className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-4">
                {viewMode === 'tasks' && hasUsableAuth && (
                  <div className="flex items-center gap-2 bg-slate-900/50 border border-slate-800 rounded-lg p-1">
                    {googleTaskLists.slice(0, 3).map(list => (
                      <button
                        key={list.id}
                        onClick={() => setActiveTaskList(list.id)}
                        className={`px-3 py-1.5 rounded-md text-sm font-black uppercase transition-all ${activeTaskList === list.id ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}
                      >
                        {list.title}
                      </button>
                    ))}
                    {googleTaskLists.length > 3 && (
                      <select
                        value={activeTaskList}
                        onChange={(e) => setActiveTaskList(e.target.value)}
                        className="bg-transparent text-sm font-black text-slate-500 uppercase outline-none px-2 cursor-pointer"
                      >
                        {googleTaskLists.slice(3).map(list => (
                          <option key={list.id} value={list.id} className="bg-slate-900">{list.title}</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
                <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-4 py-2 flex items-center gap-3 w-56">
                  <Clock className="w-3.5 h-3.5 text-slate-600" />
                  <span className="text-sm font-black text-slate-400 uppercase tracking-tight">{new Date().toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
                </div>
              </div>
            </div>
          </header>

          {/* MOBILE HEADER & NAV */}
          <div className="md:hidden flex flex-col gap-4 mb-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
                  <CheckCircle2 className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h1 className="text-xl font-black text-white uppercase tracking-tight leading-none">Bitevní Plán</h1>
                  <p className="mt-1 text-[10px] font-black text-slate-500 uppercase tracking-widest">
                    v{buildInfo.version}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setViewMode('debug')}
                  className={`p-2 border border-white/5 rounded-xl ${viewMode === 'debug' ? 'bg-indigo-600 text-white' : 'bg-slate-900 text-slate-400'}`}
                  aria-label="Diagnostika"
                  title="Diagnostika"
                >
                  <FileText className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setShowSettings(true)}
                  className="p-2 bg-slate-900 border border-white/5 rounded-xl text-slate-400 flex items-center gap-1.5"
                >
                  <Settings className="w-4 h-4" />
                  {(() => {
                    const { Icon: MobileSyncIcon, tone: mobileTone, spin: mobileSpin } = syncIconFor(syncVisualState);
                    return (
                      <MobileSyncIcon
                        aria-hidden="true"
                        className={`w-3 h-3 ${mobileTone} ${mobileSpin ? 'animate-spin' : ''}`}
                      />
                    );
                  })()}
                </button>
                <div className={`w-2 h-2 rounded-full ${isAiActive ? 'bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]' : 'bg-slate-800 border border-white/5'}`} />
              </div>
            </div>

            <nav className="flex items-center justify-between bg-[#0d1117]/80 backdrop-blur-md p-1.5 rounded-2xl border border-white/5 shadow-xl overflow-x-auto no-scrollbar">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = viewMode === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setViewMode(item.id as ViewMode)}
                    className={`flex flex-col items-center gap-1.5 px-5 py-3 rounded-xl transition-all ${isActive ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' : 'text-slate-500'}`}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-xs font-black uppercase tracking-widest">{item.label}</span>
                  </button>
                );
              })}
            </nav>

            {viewMode === 'week' && (
              <div className="flex items-center justify-between bg-slate-900/40 px-4 py-2 rounded-xl border border-white/5">
                <h2 className="text-xs font-black text-white uppercase tracking-widest">
                  {new Date(getWeekDays(weekOffset)[0].full).toLocaleDateString('cs-CZ', { month: 'short', year: 'numeric' })}
                </h2>
                <div className="flex gap-2">
                  <button onClick={() => setWeekOffset(prev => prev - 1)} className="p-2 rounded-lg bg-slate-900 border border-white/5 text-slate-400"><ChevronLeft className="w-4 h-4" /></button>
                  <button onClick={() => setWeekOffset(0)} className="px-4 py-2 rounded-lg bg-slate-900 border border-white/5 text-sm font-black text-white uppercase tracking-widest">Dnes</button>
                  <button onClick={() => setWeekOffset(prev => prev + 1)} className="p-2 rounded-lg bg-slate-900 border border-white/5 text-slate-400"><ChevronRight className="w-4 h-4" /></button>
                </div>
              </div>
            )}
          </div>

          {hasUsableAuth && showOnboarding && <OnboardingCard onDismiss={handleDismissOnboarding} />}

          {viewMode === 'suggestions' && (
            <Suspense fallback={pageFallback}>
              <SuggestionsPage googleAuth={googleAuth} onAddLog={addLog} />
            </Suspense>
          )}

          {viewMode === 'worklogs' && (
            <Suspense fallback={pageFallback}>
              <WorkLogsPage
                onAddLog={addLog}
                onVoiceControllerChange={setWorkLogVoiceController}
              />
            </Suspense>
          )}

          {viewMode === 'week' && (
            <WeeklyCalendar
              weekOffset={weekOffset}
              tasks={tasks}
              rowHeight={ROW_HEIGHT}
              calendarHours={CALENDAR_HOURS}
              currentTime={currentTime}
              currentHourPosition={currentHourPosition}
              setEditingTask={setEditingTask}
            />
          )}

          {viewMode === 'debug' && (
            <Suspense fallback={pageFallback}>
              <DiagnosticsPage
                syncHealth={syncHealth}
                logs={debugLogs}
                selectedModel={selectedModel}
                apiKeySuffix={apiKey.slice(-6)}
                isAiActive={isAiActive}
                onClearLogs={() => setDebugLogs([])}
              />
            </Suspense>
          )}


          {showTaskGrid && (
            <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-start">
              <AnimatePresence mode="popLayout">
                {tasks.length === 0 ? (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-20 text-center bg-slate-900/20 rounded-3xl border border-dashed border-slate-800">
                    <AlertCircle className="w-12 h-12 text-slate-800 mx-auto mb-4" />
                    <p className="text-slate-500 font-bold uppercase text-xs tracking-widest">Seznam je prázdný</p>
                  </motion.div>
                ) : (
                  tasks.map((task) => (
                    <TaskCard
                      key={task.isGoogleTask ? `g-${task.googleId}` : `l-${task.id}`}
                      task={task}
                      activeVoiceUpdateId={activeVoiceUpdateId}
                      isOverCapacity={memoizedIsOverCapacity}
                      getUrgencyColor={getUrgencyColor}
                      handleExport={handleExport}
                      handleDeleteTask={handleDeleteTask}
                      getDeadlineColor={memoizedGetDeadlineColor}
                      formatTimeLeft={memoizedFormatTimeLeft}
                      toggleSubtask={toggleSubtask}
                      handleToggleTask={handleToggleTask}
                      setEditingTask={setEditingTask}
                      stopRecording={stopRecording}
                      setActiveVoiceUpdateId={setActiveVoiceUpdateId}
                      activeVoiceUpdateIdRef={activeVoiceUpdateIdRef}
                      startRecording={startRecording}
                    />
                  ))
                )}
              </AnimatePresence>
            </section>
          )}

          <AnimatePresence>
            {workLogExtracted && (
              <WorkLogVoiceConfirm
                extracted={workLogExtracted}
                onConfirmed={(result) => {
                  const totalHours = result.workLogs.reduce((sum, log) => sum + log.hours, 0);
                  addLog(`Činnosti uloženy z hlasu: ${result.workLogs.length} záznamů (${totalHours.toFixed(2)}h)`, 'info');
                  setWorkLogExtracted(null);
                }}
                onCancelled={() => {
                  setWorkLogExtracted(null);
                  clearAudio();
                  isProcessingRef.current = false;
                }}
              />
            )}
          </AnimatePresence>

          <AnimatePresence>
            {editingTask && (
              <FocusEditor
                editingTask={editingTask}
                setEditingTask={setEditingTask}
                activeVoiceUpdateId={activeVoiceUpdateId}
                isRecording={isRecording}
                stopRecording={stopRecording}
                startRecording={startRecording}
                setActiveVoiceUpdateId={setActiveVoiceUpdateId}
                activeVoiceUpdateIdRef={activeVoiceUpdateIdRef}
                handleDeleteTask={handleDeleteTask}
                handleSyncToGoogle={handleSyncToGoogle}
                handleSaveEdit={handleSaveEdit}
                googleAuth={googleAuth}
                isOverCapacity={memoizedIsOverCapacity}
                getDeadlineColor={memoizedGetDeadlineColor}
                formatTimeLeft={memoizedFormatTimeLeft}
              />
            )}
          </AnimatePresence>

          <AnimatePresence>
            {showSettings && (
              <SettingsModal
                apiKey={apiKey}
                setApiKey={setApiKey}
                selectedModel={selectedModel}
                setSelectedModel={setSelectedModel}
                availableModels={AVAILABLE_MODELS}
                uiScale={uiScale}
                setUiScale={setUiScale}
                googleAuth={googleAuth}
                lastSync={lastSync}
                saveSettings={saveSettings}
                setShowSettings={setShowSettings}
              />
            )}
          </AnimatePresence>
          <AnimatePresence>
            {!editingTask && (
              <div className="fixed bottom-6 left-1/2 -translate-x-1/2 md:left-auto md:right-10 md:translate-x-0 z-[110] transition-all duration-500">
                <div className="relative">
                  <AnimatePresence>
                    {floatingMicIsRecording && <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1.6, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} className={`absolute inset-0 ${activeVoiceUpdateId || isWorkLogVoiceMode ? 'bg-red-500/40' : 'bg-indigo-500/30'} rounded-full blur-3xl animate-pulse`} />}
                  </AnimatePresence>
                  <button
                    onClick={async () => {
                      if (activeWorkLogVoiceController) {
                        await activeWorkLogVoiceController.toggle();
                        return;
                      }
                      if (isRecording) {
                        stopRecording();
                        return;
                      }
                      const targetId = null;
                      activeVoiceUpdateIdRef.current = targetId;
                      setActiveVoiceUpdateId(targetId);
                      void startRecording({
                        enableFeedback: true,
                        onSilence: () => stopRecording(),
                        silenceThreshold: -45,
                        silenceDuration: 5000 // Longer for main mic as it might be dictating longer thoughts
                      }).catch((err) => {
                        addLog(`Mikrofon: ${getErrorMessage(err)}`, 'error');
                      });
                    }}
                    disabled={floatingMicDisabled}
                    title={isWorkLogVoiceMode ? 'Nadiktovat pracovní činnost — Anu vytvoří worklog podle projektu, lidí, hodin a popisu.' : 'Spustit diktování — Anu vytvoří task / worklog / nápad podle toho, co řekneš.'}
                    className={`relative z-10 w-14 h-14 md:w-20 md:h-20 rounded-full flex items-center justify-center transition-all shadow-2xl ${floatingMicIsRecording ? 'bg-red-500 scale-110 shadow-red-500/50' : floatingMicIsProcessing ? 'bg-slate-800' : 'bg-indigo-600 shadow-indigo-600/50 hover:scale-105'}`}
                  >
                    {floatingMicIsProcessing ? <div className="w-5 h-5 md:w-8 md:h-8 border-4 border-slate-500 border-t-white rounded-full animate-spin" /> : (floatingMicIsRecording ? <MicOff className="w-5 h-5 md:w-8 md:h-8 text-white" /> : <Mic className="w-5 h-5 md:w-8 md:h-8 text-white" />)}
                  </button>
                </div>
              </div>
            )}
          </AnimatePresence>
          <SlashCommandPalette
            onOpenVoice={() => setViewMode('battle')}
            onOpenWorklogs={() => setViewMode('worklogs')}
            onOpenSuggestions={() => setViewMode('suggestions')}
            onOpenDiagnostics={() => setViewMode('debug')}
          />
        </div>
      </main>
    </div>
  );
}

export default App;
