import { useState, useEffect, useMemo, useRef } from 'react';
import { Mic, MicOff, CheckCircle2, AlertCircle, List, Users, Lightbulb, Clock, Settings, ChevronLeft, ChevronRight, LayoutGrid } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAudioRecorder } from './hooks/useAudioRecorder';
import { db, type Task } from './db';
import { useLiveQuery } from 'dexie-react-hooks';
import { geminiService } from './services/geminiService';
import { googleService } from './services/googleService';
import type { ViewMode, UnifiedTask, GoogleAuthStatus } from './types';
import { Sidebar } from './components/Sidebar';
import { TaskCard } from './components/TaskCard';
import { FocusEditor } from './components/FocusEditor';
import { SettingsModal } from './components/SettingsModal';
import { WeeklyCalendar } from './components/WeeklyCalendar';
import {
  formatTimeLeft,
  getDeadlineColor,
  isOverCapacity,
  getWeekDays,
  getUrgencyColor
} from './utils/calendarUtils';
import { applySemanticResult } from './services/semanticEngine';

function App() {
  const { isRecording, startRecording, stopRecording, audioBlob, clearAudio } = useAudioRecorder();
  const [viewMode, setViewMode] = useState<ViewMode>('battle');
  const [editingTask, setEditingTask] = useState<UnifiedTask | null>(null);
  const [activeVoiceUpdateId, setActiveVoiceUpdateId] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState('gemini-2.0-flash');
  const availableModels = [
    'gemini-2.0-flash',   // Default - nejlepší poměr cena/výkon
    'gemini-1.5-flash',   // Ultra levný
    'gemini-2.5-flash',   // Premium kvalita
    'gemini-1.5-pro'      // Komplexní analýza
  ];
  const [googleAuth, setGoogleAuth] = useState<GoogleAuthStatus>({ isSignedIn: false, accessToken: null });
  const [weekOffset, setWeekOffset] = useState(0);
  const [lastSync, setLastSync] = useState<string | null>(localStorage.getItem('last_drive_sync'));
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [uiScale, setUiScale] = useState<number>(Number(localStorage.getItem('ui_scale')) || 16);
  const [googleTaskLists, setGoogleTaskLists] = useState<any[]>([]);
  const [activeTaskList, setActiveTaskList] = useState<string>('@default');
  const [googleTasksRaw, setGoogleTasksRaw] = useState<any[]>([]);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [debugLogs, setDebugLogs] = useState<{ t: string, m: string, type: 'info' | 'error' }[]>([]);
  const activeVoiceUpdateIdRef = useRef<number | null>(null);

  const addLog = (message: string, type: 'info' | 'error' = 'info') => {
    const time = new Date().toLocaleTimeString('cs-CZ');
    setDebugLogs(prev => [{ t: time, m: message, type }, ...prev].slice(0, 50));
    console.log(`[${type.toUpperCase()}] ${message} `);
  };

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const CALENDAR_HOURS = useMemo(() => Array.from({ length: 13 }, (_, i) => i + 7), []); // 7:00 to 19:00
  const ROW_HEIGHT = 80;

  const currentHourPosition = useMemo(() => {
    const hours = currentTime.getHours();
    const minutes = currentTime.getMinutes();
    if (hours < 7 || hours >= 20) return -1;
    const totalMinutes = (hours - 7) * 60 + minutes;
    return (totalMinutes / 60) * ROW_HEIGHT;
  }, [currentTime]);

  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${uiScale} px`);
    db.settings.put({ id: 'ui_scale', value: uiScale.toString() });
    // Auto-scroll to top when view changes on desktop
    document.querySelector('main')?.scrollTo(0, 0);
  }, [uiScale, viewMode]);

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

  useEffect(() => {
    const cleanup = async () => {
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      // Delete tasks that were completed OR soft-deleted more than 30 days ago
      const toDelete = await db.tasks
        .filter(t => (t.status === 'completed' || !!t.isDeleted) && (t.updatedAt || t.createdAt) < thirtyDaysAgo)
        .primaryKeys();
      if (toDelete.length > 0) {
        await db.tasks.bulkDelete(toDelete);
      }
    };
    cleanup();
  }, []);

  useEffect(() => {
    const initGoogle = async () => {
      await googleService.init();
      let status = googleService.getAuthStatus();

      // Pokus o automatické obnovení tokenu, pokud je expirovaný, ale uživatel už byl přihlášen
      if (!status.isSignedIn && localStorage.getItem('google_user_email')) {
        await googleService.trySilentRefresh();
        status = googleService.getAuthStatus();
      }

      setGoogleAuth(status);
    };
    initGoogle();

    const handleAuthChange = (e: any) => setGoogleAuth(e.detail);
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
  }, []);


  const localTasks = useLiveQuery(async () => {
    if (viewMode === 'battle') {
      return await db.tasks
        .where('status').equals('pending')
        .and(t => t.type !== 'thought' && t.type !== 'note')
        .toArray()
        .then(all => all.sort((a, b) => {
          const dateA = a.deadline || a.date || '9999-12-31';
          const dateB = b.deadline || b.date || '9999-12-31';
          if (dateA !== dateB) return dateA.localeCompare(dateB);
          const timeA = a.startTime || '15:00';
          const timeB = b.startTime || '15:00';
          if (timeA !== timeB) return timeA.localeCompare(timeB);
          return (b.urgency || 0) - (a.urgency || 0);
        }));
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
    else if (viewMode === 'thoughts') collection = db.tasks.where('type').anyOf(['thought', 'note']).and(t => !t.isDeleted);
    else collection = db.tasks.filter(t => !t.isDeleted);

    const all = await collection.toArray();
    return all.sort((a, b) => {
      if (a.status === b.status) return (b.urgency || 0) - (a.urgency || 0);
      return a.status === 'completed' ? 1 : -1;
    });
  }, [viewMode, weekOffset]) || [];

  // Mapped Google Tasks
  const googleTasksMapped: UnifiedTask[] = useMemo(() => {
    if (!googleAuth.isSignedIn || (viewMode !== 'tasks' && viewMode !== 'battle' && viewMode !== 'week')) return [];

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
  }, [googleTasksRaw, googleAuth.isSignedIn, viewMode, activeTaskList]);

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

  // Auto-sync check on start AND on focus/visibility change
  useEffect(() => {
    if (!googleAuth.isSignedIn) return;

    googleService.getTaskLists().then(setGoogleTaskLists);

    const checkSync = async () => {
      try {
        const status = googleService.getAuthStatus();
        if (!status.isSignedIn && localStorage.getItem('google_access_token')) {
          const success = await googleService.trySilentRefresh();
          if (success) {
            setGoogleAuth(googleService.getAuthStatus());
          }
        }

        const payload = await googleService.loadFromDrive();
        if (payload && payload.data) {
          const cloudTimestamp = payload.timestamp || 0;

          const { tasks: driveTasks, settings: driveSettings } = payload.data;

          if (driveSettings) {
            for (const s of driveSettings) {
              await db.settings.put(s);
              if (s.id === 'gemini_api_key') setApiKey(s.value);
              if (s.id === 'gemini_model') setSelectedModel(s.value);
              if (s.id === 'ui_scale') setUiScale(Number(s.value));
            }
          }

          if (driveTasks && Array.isArray(driveTasks)) {
            let changesMade = false;
            for (const cloudTask of driveTasks) {
              if (!cloudTask.id) continue;
              const localTask = await db.tasks.get(cloudTask.id);

              if (!localTask) {
                // New task from cloud
                await db.tasks.add(cloudTask);
                changesMade = true;
              } else {
                // Compare versions
                const cloudUpdated = cloudTask.updatedAt || cloudTask.createdAt || 0;
                const localUpdated = localTask.updatedAt || localTask.createdAt || 0;

                if (cloudUpdated > localUpdated) {
                  await db.tasks.put(cloudTask);
                  changesMade = true;
                }
              }
            }

            if (changesMade) {
              addLog(`Synchronizace: Staženy novější změny z cloudu.`);
            }
          }

          const now = new Date().toLocaleString('cs-CZ');
          setLastSync(now);
          localStorage.setItem('last_drive_sync', now);
          localStorage.setItem('last_drive_sync_ts', cloudTimestamp.toString());
        }
      } catch (e) {
        console.error("Auto-sync check failed", e);
      }
    };

    // Run on mount
    checkSync();

    // Run whenever app becomes visible (e.g. unlocking phone or switching tabs)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkSync();
      }
    };

    window.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', checkSync); // Backup for some mobile browsers

    return () => {
      window.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', checkSync);
    };
  }, [googleAuth.isSignedIn]);

  useEffect(() => {
    if (googleAuth.isSignedIn) {
      googleService.getTasks(activeTaskList).then(setGoogleTasksRaw);
    }
  }, [googleAuth.isSignedIn, viewMode, activeTaskList]);

  // Auto-backup on change
  useEffect(() => {
    if (!googleAuth.isSignedIn) return;

    const timer = setTimeout(async () => {
      try {
        const allTasks = await db.tasks.toArray();
        const allSettings = await db.settings.toArray();
        const savedTimestamp = await googleService.saveToDrive({ tasks: allTasks, settings: allSettings });

        if (savedTimestamp) {
          const now = new Date().toLocaleString('cs-CZ');
          setLastSync(now);
          localStorage.setItem('last_drive_sync', now);
          localStorage.setItem('last_drive_sync_ts', savedTimestamp.toString());
          addLog('Automatická záloha na Disk úspěšná');
        }
        console.log('Auto-backup completed');
      } catch (e) {
        console.error('Auto-backup failed', e);
      }
    }, 3000); // Faster Debounce: 3s

    return () => clearTimeout(timer);
  }, [tasks, googleAuth.isSignedIn]);

  useEffect(() => {
    db.settings.get('gemini_api_key').then(setting => {
      if (setting) setApiKey(setting.value);
    });
    db.settings.get('gemini_model').then(setting => {
      if (setting) {
        // Validate if the saved model is still in our allowed list
        const isValid = availableModels.includes(setting.value);
        if (isValid) {
          setSelectedModel(setting.value);
        } else {
          // Reset to default if the model is no longer supported
          setSelectedModel('gemini-2.0-flash');
          db.settings.put({ id: 'gemini_model', value: 'gemini-2.0-flash' });
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
    await geminiService.init();
  };


  const handleProcessAudio = async (blob: Blob) => {
    if (isProcessing) return;
    setIsProcessing(true);

    // Use the REF to get the correct ID even in an async/stale closure scenario
    const updateId = activeVoiceUpdateIdRef.current;

    addLog(`Zpracovávám audio s modelem: ${selectedModel} (Update ID: ${updateId || 'NOVÝ'})`);

    try {
      const result = await geminiService.processAudio(
        blob,
        updateId || undefined,
        (attempt, delay) => addLog(`AI Přetíženo - Pokus č.${attempt} (čekám ${delay / 1000}s)...`, 'info')
      );
      if (result) {
        addLog(`AI analýza úspěšná: ${result.title} (${updateId ? 'AKTUALIZACE' : 'NOVÝ'})`);
        await applyAiResult(result, updateId);
      }
    } catch (err: any) {
      addLog('AI Chyba: ' + err.message, 'error');
      alert(err.message || "Chyba při zpracování AI");
    } finally {
      setIsProcessing(false);
      activeVoiceUpdateIdRef.current = null;
      setActiveVoiceUpdateId(null);
      clearAudio();
    }
  };

  useEffect(() => {
    if (audioBlob) {
      handleProcessAudio(audioBlob);
    }
  }, [audioBlob, selectedModel]);

  const applyAiResult = async (result: any, updateId: number | null) => {
    const semanticOutput = await applySemanticResult(result, updateId, googleAuth);
    if (!semanticOutput) return;

    if (updateId && semanticOutput.updatedId) {
      if (editingTask && editingTask.id === updateId) {
        setEditingTask(prev => prev ? { ...prev, ...semanticOutput.result } : null);
      }
    }
  };

  const toggleSubtask = async (task: Task, subTaskId: string) => {
    if (!task.id || !task.subTasks) return;
    const newSubTasks = task.subTasks.map(st => st.id === subTaskId ? { ...st, completed: !st.completed } : st);
    const completedCount = newSubTasks.filter(st => st.completed).length;
    const newProgress = Math.round((completedCount / newSubTasks.length) * 100);
    const total = task.totalDuration || task.duration || 0;
    const newDuration = Math.round(total * (1 - newProgress / 100));

    await db.tasks.update(task.id, {
      subTasks: newSubTasks,
      progress: newProgress,
      duration: newDuration,
      totalDuration: total,
      updatedAt: Date.now()
    } as any);
  };

  const handleToggleTask = async (task: UnifiedTask) => {
    if (task.isGoogleTask && task.googleId && googleAuth.isSignedIn) {
      const newStatus = task.status === 'completed' ? 'needsAction' : 'completed';
      await googleService.updateGoogleTask(task.googleId, { status: newStatus }, task.googleListId);
      // Refresh google tasks
      googleService.getTasks(activeTaskList).then(setGoogleTasksRaw);
    } else if (task.id) {
      await db.tasks.update(task.id, {
        status: task.status === 'completed' ? 'pending' : 'completed',
        updatedAt: Date.now()
      });
    }
  };

  const handleDeleteTask = async (task: UnifiedTask) => {
    if (!confirm('Opravdu smazat tento záznam?')) return;

    if (task.isGoogleTask && task.googleId && googleAuth.isSignedIn) {
      await googleService.deleteGoogleTask(task.googleId, task.googleListId);
      googleService.getTasks(activeTaskList).then(setGoogleTasksRaw);
    } else if (task.id) {
      if (task.googleEventId && googleAuth.isSignedIn) {
        try { await googleService.deleteFromCalendar(task.googleEventId); } catch (e) { }
      }
      await db.tasks.update(task.id, { isDeleted: true, updatedAt: Date.now() });
    }
  };

  const handleSaveEdit = async () => {
    if (editingTask) {
      if (editingTask.isGoogleTask && editingTask.googleId && googleAuth.isSignedIn) {
        await googleService.updateGoogleTask(editingTask.googleId, {
          title: editingTask.title,
          notes: editingTask.description
        }, editingTask.googleListId);
        googleService.getTasks(activeTaskList).then(setGoogleTasksRaw);
      } else if (editingTask.id) {
        await db.tasks.update(editingTask.id, { ...editingTask, updatedAt: Date.now() } as any);
        if (editingTask.type === 'meeting' && googleAuth.isSignedIn) {
          try {
            const eventId = await googleService.addToCalendar(editingTask);
            if (eventId && eventId !== editingTask.googleEventId) {
              await db.tasks.update(editingTask.id, { googleEventId: eventId, updatedAt: Date.now() });
            }
          } catch (e) {
            console.error("Save Google sync failed", e);
          }
        }
      }
      setEditingTask(null);
    }
  };

  const handleSyncToGoogle = async (task: Task) => {
    if (!task.id || !googleAuth.isSignedIn) {
      alert("Pro synchronizaci musíte být přihlášeni ke Googlu.");
      return;
    }
    setIsProcessing(true);
    try {
      const eventId = await googleService.addToCalendar(task);
      if (eventId) {
        await db.tasks.update(task.id, { googleEventId: eventId, updatedAt: Date.now() });
      }
    } catch (err: any) {
      alert(err.message || "Chyba při synchronizaci s Googlem");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExport = (task: Task) => {
    const subTasksText = (task.subTasks || []).map(st => `${st.completed ? '✅' : '☐'} ${st.title}`).join('\n');
    const body = `=== ${task.title} ===\nTermín: ${task.deadline || task.date || 'Neurčeno'} | Urgence: ${task.urgency}/3\nPokrok: ${task.progress || 0}%\n--------------------------------------\nPOPIS:\n${task.description || 'Bez popisu'}\n\n${subTasksText ? `PŘEHLED PODÚKOLŮ:\n${subTasksText}\n` : ''}INTERNÍ ZÁPIS:\n${task.internalNotes || 'Bez dodatečného zápisu'}\n\n--\nOdesláno z aplikace Bitevní Plán`.trim();
    const subject = `${task.title} [BP]`;
    const mailtoUrl = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = mailtoUrl;
  };

  const navItems = [
    { id: 'battle', label: 'Plán', icon: List },
    { id: 'week', label: 'Týden', icon: LayoutGrid },
    { id: 'tasks', label: 'Úkoly', icon: CheckCircle2 },
    { id: 'meetings', label: 'Schůzky', icon: Users },
    { id: 'thoughts', label: 'Myšlenky', icon: Lightbulb },
  ];

  return (
    <div className="flex h-screen bg-slate-950 overflow-hidden font-body text-slate-200">
      <Sidebar
        viewMode={viewMode}
        setViewMode={setViewMode}
        isAiActive={isAiActive}
        navItems={navItems}
        setShowSettings={setShowSettings}
        isProcessing={isProcessing}
      />

      {/* MAIN CONTENT AREA */}
      <main className={`flex-1 relative ${viewMode === 'week' ? 'overflow-hidden' : 'overflow-y-auto'} overflow-x-hidden flex flex-col no-scrollbar bg-slate-950`}>
        <div className={`w-full h-full flex flex-col ${viewMode === 'week' ? 'px-0 py-0 max-w-full' : 'px-4 md:px-8 lg:px-10 py-6 md:py-8 max-w-[1600px] mx-auto'} ${viewMode === 'week' ? 'pb-0' : 'pb-32 md:pb-12'}`}>

          <header className={`hidden md:flex flex-col gap-1 border-b border-slate-900 ${viewMode === 'week' ? 'mb-0 pb-0 pt-4 px-6 md:px-10' : 'mb-6 pb-4'}`}>
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-black text-white uppercase tracking-tight">
                  {navItems.find(i => i.id === viewMode)?.label}
                </h1>
                <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-1">
                  {viewMode === 'battle' ? 'Strategický přehled dne' :
                    viewMode === 'week' ? 'Plánování týdenních cílů' :
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
                {viewMode === 'tasks' && googleAuth.isSignedIn && (
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
                <h1 className="text-xl font-black text-white uppercase tracking-tight">Bitevní Plán</h1>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setShowSettings(true)}
                  className="p-2 bg-slate-900 border border-white/5 rounded-xl text-slate-400"
                >
                  <Settings className="w-4 h-4" />
                </button>
                <div className={`w-2 h-2 rounded-full ${isAiActive ? 'bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]' : 'bg-slate-800 border border-white/5'}`} />
              </div>
            </div>

            <nav className="flex items-center justify-between bg-[#0d1117]/80 backdrop-blur-md p-1.5 rounded-2xl border border-white/5 shadow-xl overflow-x-auto no-scrollbar">
              {navItems.map((item) => {
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

          {viewMode === ('debug' as any) && (
            <div className="flex-1 flex flex-col gap-4 min-h-0">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-black text-white uppercase tracking-widest">Systémové Logy (v4.0.0)</h2>
                <button
                  onClick={() => setDebugLogs([])}
                  className="px-3 py-1 bg-slate-800 hover:bg-red-900/20 text-slate-400 hover:text-red-400 rounded-lg text-sm font-black uppercase transition-all"
                >
                  Smazat
                </button>
              </div>
              <div className="flex-1 bg-slate-900/50 rounded-2xl border border-slate-800 overflow-y-auto p-4 font-mono text-xs space-y-1">
                {debugLogs.length === 0 ? (
                  <div className="text-slate-600 italic">Žádné logy k dispozici...</div>
                ) : (
                  debugLogs.map((log, i) => (
                    <div key={i} className={`flex gap-3 ${log.type === 'error' ? 'text-red-400 bg-red-400/5' : 'text-slate-400'} py-1 px-2 rounded`}>
                      <span className="opacity-50 shrink-0">[{log.t}]</span>
                      <span className="break-all">{log.m}</span>
                    </div>
                  ))
                )}
              </div>
              <div className="p-4 bg-slate-800/30 rounded-2xl border border-slate-800/50">
                <h3 className="text-xs font-black text-slate-500 uppercase mb-2">Aktivní Konfigurace</h3>
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <span className="text-slate-500">Model:</span> <span className="text-white">{selectedModel}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">API Stav:</span> <span className={isAiActive ? 'text-emerald-400' : 'text-red-400'}>{isAiActive ? 'Aktivní' : 'Chybí klíč/Offline'}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-slate-500">Klíč:</span> <span className="text-white">...{apiKey.slice(-6)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}


          {viewMode !== 'week' && (
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
                      isOverCapacity={isOverCapacity.bind(null, currentTime)}
                      getUrgencyColor={getUrgencyColor}
                      handleExport={handleExport}
                      handleDeleteTask={handleDeleteTask}
                      getDeadlineColor={getDeadlineColor.bind(null, currentTime)}
                      formatTimeLeft={formatTimeLeft.bind(null, currentTime)}
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
            {editingTask && (
              <FocusEditor
                editingTask={editingTask}
                setEditingTask={setEditingTask as any}
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
                isOverCapacity={isOverCapacity.bind(null, currentTime)}
                getDeadlineColor={getDeadlineColor.bind(null, currentTime)}
                formatTimeLeft={formatTimeLeft.bind(null, currentTime)}
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
                availableModels={availableModels}
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
                    {isRecording && <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1.6, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} className={`absolute inset-0 ${activeVoiceUpdateId ? 'bg-red-500/40' : 'bg-indigo-500/30'} rounded-full blur-3xl animate-pulse`} />}
                  </AnimatePresence>
                  <button
                    onClick={isRecording ? () => {
                      stopRecording();
                    } : async () => {
                      const targetId = null;
                      activeVoiceUpdateIdRef.current = targetId;
                      setActiveVoiceUpdateId(targetId);
                      startRecording({
                        enableFeedback: true,
                        onSilence: () => stopRecording(),
                        silenceThreshold: -45,
                        silenceDuration: 5000 // Longer for main mic as it might be dictating longer thoughts
                      });
                    }}
                    disabled={isProcessing}
                    className={`relative z-10 w-14 h-14 md:w-20 md:h-20 rounded-full flex items-center justify-center transition-all shadow-2xl ${isRecording ? 'bg-red-500 scale-110 shadow-red-500/50' : isProcessing ? 'bg-slate-800' : 'bg-indigo-600 shadow-indigo-600/50 hover:scale-105'}`}
                  >
                    {isProcessing ? <div className="w-5 h-5 md:w-8 md:h-8 border-4 border-slate-500 border-t-white rounded-full animate-spin" /> : (isRecording ? <MicOff className="w-5 h-5 md:w-8 md:h-8 text-white" /> : <Mic className="w-5 h-5 md:w-8 md:h-8 text-white" />)}
                  </button>
                </div>
              </div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

export default App;
