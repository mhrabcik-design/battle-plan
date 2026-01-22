import { useState, useEffect } from 'react';
import { Mic, MicOff, CheckCircle2, AlertCircle, FileText, Share2, List, Users, Lightbulb, Save, X, Clock, Settings, ChevronLeft, ChevronRight, LayoutGrid, Mail, CloudUpload, CloudDownload } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAudioRecorder } from './hooks/useAudioRecorder';
import { db, type Task } from './db';
import { useLiveQuery } from 'dexie-react-hooks';
import { geminiService } from './services/geminiService';
import { googleService, type GoogleAuthStatus } from './services/googleService';

type ViewMode = 'battle' | 'week' | 'tasks' | 'meetings' | 'thoughts' | 'google-tasks';

function App() {
  const { isRecording, startRecording, stopRecording, audioBlob, clearAudio } = useAudioRecorder();
  const [viewMode, setViewMode] = useState<ViewMode>('battle');
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [activeVoiceUpdateId, setActiveVoiceUpdateId] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState('gemini-1.5-flash');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [googleAuth, setGoogleAuth] = useState<GoogleAuthStatus>({ isSignedIn: false, accessToken: null });
  const [weekOffset, setWeekOffset] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(localStorage.getItem('last_drive_sync'));
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [uiScale, setUiScale] = useState<number>(Number(localStorage.getItem('ui_scale')) || 16);
  const [googleTaskLists, setGoogleTaskLists] = useState<any[]>([]);
  const [activeTaskList, setActiveTaskList] = useState<string>('@default');
  const [googleTasksList, setGoogleTasksList] = useState<any[]>([]);

  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${uiScale}px`);
    localStorage.setItem('ui_scale', uiScale.toString());
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

  const getWeekDays = (offset: number) => {
    const today = new Date();
    const day = today.getDay();
    const diff = today.getDate() - day + (day === 0 ? -6 : 1) + (offset * 7);
    const start = new Date(today.setDate(diff));

    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return {
        full: d.toISOString().split('T')[0],
        dayName: d.toLocaleDateString('cs-CZ', { weekday: 'short' }),
        dayNum: d.getDate(),
        isToday: d.toISOString().split('T')[0] === new Date().toISOString().split('T')[0]
      };
    });
  };

  useEffect(() => {
    const cleanup = async () => {
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const toDelete = await db.tasks
        .where('status').equals('completed')
        .and(t => t.createdAt < thirtyDaysAgo)
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
      setGoogleAuth(googleService.getAuthStatus());
    };
    initGoogle();

    const handleAuthChange = (e: any) => setGoogleAuth(e.detail);
    window.addEventListener('google-auth-change', handleAuthChange);
    return () => window.removeEventListener('google-auth-change', handleAuthChange);
  }, []);


  const tasks = useLiveQuery(async () => {
    if (viewMode === 'battle') {
      return await db.tasks
        .where('status').equals('pending')
        .and(t => (t.date || t.deadline || '') >= new Date().toISOString().split('T')[0])
        .toArray()
        .then(all => all.sort((a, b) => {
          const dateA = a.date || a.deadline || '9999-12-31';
          const dateB = b.date || b.deadline || '9999-12-31';
          if (dateA !== dateB) return dateA.localeCompare(dateB);
          return (b.urgency || 0) - (a.urgency || 0);
        }));
    }

    if (viewMode === 'week') {
      const days = getWeekDays(weekOffset);
      const start = days[0].full;
      const end = days[6].full;
      const all = await db.tasks
        .where('date').between(start, end, true, true)
        .or('deadline').between(start, end, true, true)
        .toArray();
      return all.filter(t => t.status !== 'completed');
    }

    let collection;
    if (viewMode === 'tasks') collection = db.tasks.where('type').equals('task');
    else if (viewMode === 'meetings') collection = db.tasks.where('type').equals('meeting');
    else if (viewMode === 'thoughts') collection = db.tasks.where('type').anyOf(['thought', 'note']);
    else collection = db.tasks.toCollection();

    const all = await collection.toArray();
    return all.sort((a, b) => {
      if (a.status === b.status) return (b.urgency || 0) - (a.urgency || 0);
      return a.status === 'completed' ? 1 : -1;
    });
  }, [viewMode, weekOffset]) || [];

  // Auto-sync check on start
  useEffect(() => {
    if (googleAuth.isSignedIn) {
      googleService.getTaskLists().then(setGoogleTaskLists);
      const checkSync = async () => {
        const payload = await googleService.loadFromDrive();
        if (payload && payload.data) {
          const localCount = await db.tasks.count();
          if (localCount === 0) {
            const { tasks: driveTasks, settings: driveSettings } = payload.data;
            if (driveTasks) await db.tasks.bulkAdd(driveTasks);
            if (driveSettings) {
              for (const s of driveSettings) {
                await db.settings.put(s);
                if (s.id === 'gemini_api_key') setApiKey(s.value);
                if (s.id === 'gemini_model') setSelectedModel(s.value);
              }
            }
            console.log('Auto-restored from Drive (local was empty)');
          }
        }
      };
      checkSync();
    }
  }, [googleAuth.isSignedIn]);

  useEffect(() => {
    if (googleAuth.isSignedIn && viewMode === 'google-tasks') {
      googleService.getTasks(activeTaskList).then(setGoogleTasksList);
    }
  }, [googleAuth.isSignedIn, viewMode, activeTaskList]);

  // Auto-backup on change
  useEffect(() => {
    if (!googleAuth.isSignedIn || tasks.length === 0) return;

    const timer = setTimeout(async () => {
      try {
        const allTasks = await db.tasks.toArray();
        const allSettings = await db.settings.toArray();
        await googleService.saveToDrive({ tasks: allTasks, settings: allSettings });
        const now = new Date().toLocaleString('cs-CZ');
        setLastSync(now);
        localStorage.setItem('last_drive_sync', now);
        console.log('Auto-backup completed');
      } catch (e) {
        console.error('Auto-backup failed', e);
      }
    }, 10000); // Debounce 10s

    return () => clearTimeout(timer);
  }, [tasks, googleAuth.isSignedIn]);

  useEffect(() => {
    db.settings.get('gemini_api_key').then(setting => {
      if (setting) setApiKey(setting.value);
    });
    db.settings.get('gemini_model').then(setting => {
      if (setting) setSelectedModel(setting.value);
    });
  }, []);

  const fetchModels = async () => {
    if (!apiKey) return;
    const res = await geminiService.listModels();
    if (res.includes('Dostupné modely:')) {
      const models = res.replace('Dostupné modely:\n', '').split('\n');
      setAvailableModels(models);
    }
  };

  useEffect(() => {
    if (showSettings) fetchModels();
  }, [showSettings, apiKey]);

  const saveSettings = async () => {
    await db.settings.put({ id: 'gemini_api_key', value: apiKey });
    await db.settings.put({ id: 'gemini_model', value: selectedModel });
    setShowSettings(false);
    await geminiService.init();
  };

  const handleBackupToDrive = async () => {
    if (!googleAuth.isSignedIn) return;
    setIsSyncing(true);
    try {
      const allTasks = await db.tasks.toArray();
      const allSettings = await db.settings.toArray();
      await googleService.saveToDrive({ tasks: allTasks, settings: allSettings });
      const now = new Date().toLocaleString('cs-CZ');
      setLastSync(now);
      localStorage.setItem('last_drive_sync', now);
      alert('Záloha úspěšně uložena na Google Disk');
    } catch (e: any) {
      alert('Chyba při zálohování: ' + e.message);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleRestoreFromDrive = async () => {
    if (!googleAuth.isSignedIn) return;
    if (!confirm('Opravdu chcete obnovit data z Google Disku? Současná lokální data budou přepsána.')) return;

    setIsSyncing(true);
    try {
      const payload = await googleService.loadFromDrive();
      if (!payload || !payload.data) {
        alert('Na Google Disku nebyla nalezena žádná záloha.');
        return;
      }

      const { tasks: driveTasks, settings: driveSettings } = payload.data;

      // Clear and restore tasks
      await db.tasks.clear();
      if (driveTasks) await db.tasks.bulkAdd(driveTasks);

      // Restore settings if present
      if (driveSettings) {
        for (const s of driveSettings) {
          await db.settings.put(s);
          if (s.id === 'gemini_api_key') setApiKey(s.value);
          if (s.id === 'gemini_model') setSelectedModel(s.value);
        }
      }

      const now = new Date().toLocaleString('cs-CZ');
      setLastSync(now);
      localStorage.setItem('last_drive_sync', now);
      alert('Data byla úspěšně obnovena z Google Disku.');
    } catch (e: any) {
      alert('Chyba při obnově dat: ' + e.message);
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    if (audioBlob) {
      handleProcessAudio(audioBlob);
    }
  }, [audioBlob]);

  const handleProcessAudio = async (blob: Blob) => {
    setIsProcessing(true);
    const updateId = activeVoiceUpdateId;
    try {
      const result = await geminiService.processAudio(blob, updateId || undefined);
      if (result) {
        if (updateId) {
          if (result.type) {
            const aiType = String(result.type).toLowerCase();
            if (aiType.includes('task') || aiType.includes('úkol')) result.type = 'task' as any;
            else if (aiType.includes('meeting') || aiType.includes('sraz') || aiType.includes('schůzka')) result.type = 'meeting' as any;
            else if (aiType.includes('thought') || aiType.includes('myšlenka') || aiType.includes('note')) result.type = 'thought' as any;
          }
          await db.tasks.update(updateId, result as any);
        } else {
          let finalType: Task['type'] = 'thought';
          const aiType = String(result.type || 'thought').toLowerCase();
          if (aiType.includes('task') || aiType.includes('úkol')) finalType = 'task';
          else if (aiType.includes('meeting') || aiType.includes('sraz') || aiType.includes('schůzka')) finalType = 'meeting';
          else if (aiType.includes('thought') || aiType.includes('myšlenka') || aiType.includes('note')) finalType = 'thought';

          const defaultDuration = finalType === 'meeting' ? 60 : 30;

          const newTaskId = await db.tasks.add({
            title: result.title || "Nový záznam",
            description: result.description || "",
            internalNotes: result.internalNotes || "",
            type: finalType,
            urgency: Number(result.urgency) as any || 3,
            status: 'pending',
            date: result.date || new Date().toISOString().split('T')[0],
            startTime: result.startTime || (finalType === 'meeting' ? "09:00" : undefined),
            deadline: result.deadline || result.date || new Date().toISOString().split('T')[0],
            duration: Number(result.duration) || defaultDuration,
            totalDuration: Number(result.duration) || defaultDuration,
            subTasks: result.subTasks || [],
            progress: Number(result.progress) || 0,
            createdAt: Date.now()
          });

          if (finalType === 'meeting' && googleAuth.isSignedIn) {
            const addedTask = await db.tasks.get(newTaskId);
            if (addedTask) {
              try {
                const eventId = await googleService.addToCalendar(addedTask);
                if (eventId) await db.tasks.update(newTaskId, { googleEventId: eventId });
              } catch (e) {
                console.error("Auto Google sync failed", e);
              }
            }
          }
        }
      }
    } catch (err: any) {
      alert(err.message || "Chyba při zpracování AI");
    } finally {
      setIsProcessing(false);
      setActiveVoiceUpdateId(null);
      clearAudio();
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
      totalDuration: total
    } as any);
  };

  const handleSaveEdit = async () => {
    if (editingTask && editingTask.id) {
      await db.tasks.update(editingTask.id, editingTask as any);
      if (editingTask.type === 'meeting' && googleAuth.isSignedIn) {
        try {
          const eventId = await googleService.addToCalendar(editingTask);
          if (eventId && eventId !== editingTask.googleEventId) {
            await db.tasks.update(editingTask.id, { googleEventId: eventId });
          }
        } catch (e) {
          console.error("Save Google sync failed", e);
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
        await db.tasks.update(task.id, { googleEventId: eventId });
      }
    } catch (err: any) {
      alert(err.message || "Chyba při synchronizaci s Googlem");
    } finally {
      setIsProcessing(false);
    }
  };

  const getUrgencyColor = (urgency: number) => {
    switch (urgency) {
      case 5: return 'text-red-400 border-red-400/30 bg-red-400/10';
      case 4: return 'text-orange-400 border-orange-400/30 bg-orange-400/10';
      case 3: return 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10';
      default: return 'text-blue-400 border-blue-400/30 bg-blue-400/10';
    }
  };

  const handleExport = (task: Task) => {
    const subTasksText = (task.subTasks || []).map(st => `${st.completed ? '✅' : '☐'} ${st.title}`).join('\n');
    const body = `=== ${task.title} ===\nTermín: ${task.deadline || task.date || 'Neurčeno'} | Urgence: ${task.urgency}/5\nPokrok: ${task.progress || 0}%\n--------------------------------------\nPOPIS:\n${task.description || 'Bez popisu'}\n\n${subTasksText ? `PŘEHLED PODÚKOLŮ:\n${subTasksText}\n` : ''}INTERNÍ ZÁPIS:\n${task.internalNotes || 'Bez dodatečného zápisu'}\n\n--\nOdesláno z aplikace Bitevní Plán`.trim();
    const subject = `[BITEVNÍ PLÁN] ${task.title}`;
    const mailtoUrl = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = mailtoUrl;
  };

  const navItems = [
    { id: 'battle', label: 'Plán', icon: List },
    { id: 'week', label: 'Týden', icon: LayoutGrid },
    { id: 'tasks', label: 'Úkoly', icon: CheckCircle2 },
    { id: 'google-tasks', label: 'G-Úkoly', icon: CheckCircle2, hideMobile: true },
    { id: 'meetings', label: 'Schůzky', icon: Users },
    { id: 'thoughts', label: 'Myšlenky', icon: Lightbulb },
  ];

  return (
    <div className="flex h-screen bg-slate-950 overflow-hidden font-body text-slate-200">
      {/* SIDEBAR FOR DESKTOP - Office/Professional Style */}
      <aside className="hidden md:flex flex-col w-72 border-r border-slate-800 bg-slate-900 shadow-xl shrink-0 relative z-[60]">
        <div className="p-8 flex flex-col items-start gap-1 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-600/20">
              <CheckCircle2 className="w-5 h-5 text-white" />
            </div>
            <span className="text-lg font-black uppercase tracking-tight text-white leading-none">Bitevní Plán</span>
          </div>
          <span className="text-[10px] text-slate-500 font-bold tracking-widest uppercase ml-10">Productivity Suite 2.0</span>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-8">
          <nav className="space-y-1">
            <h3 className="px-4 text-[10px] font-black text-slate-600 uppercase tracking-[0.2em] mb-4">Nástroje</h3>
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = viewMode === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setViewMode(item.id as ViewMode)}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-xl transition-all duration-200 group ${isActive ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'}`}
                >
                  <Icon className={`w-5 h-5 ${isActive ? 'scale-100' : 'group-hover:scale-110'} transition-transform`} />
                  <span className="text-sm font-bold tracking-tight">{item.label}</span>
                  {isActive && (
                    <motion.div layoutId="active-indicator" className="ml-auto w-1.5 h-6 bg-white/20 rounded-full" />
                  )}
                </button>
              );
            })}
          </nav>

          <div className="space-y-4">
            <h3 className="px-4 text-[10px] font-black text-slate-600 uppercase tracking-[0.2em]">Systém</h3>
            <div className="space-y-2">
              {/* AI STATUS IN SIDEBAR */}
              <div className="mx-2 flex items-center gap-3 p-4 rounded-2xl bg-slate-800/50 border border-slate-800">
                <div className={`w-2.5 h-2.5 rounded-full ${isAiActive ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-slate-700'}`} />
                <div className="flex flex-col">
                  <span className="text-[10px] font-black text-white uppercase tracking-wider leading-none">AI ARCHITEKT</span>
                  <span className={`text-[9px] font-bold ${isAiActive ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {isAiActive ? 'PŘIPOJENO' : 'OFFLINE'}
                  </span>
                </div>
              </div>

              <button
                onClick={() => setShowSettings(true)}
                className="mx-2 w-[calc(100%-1rem)] flex items-center gap-3 px-4 py-4 hover:bg-white/5 text-slate-400 hover:text-white rounded-2xl transition-all font-bold uppercase text-[10px] tracking-widest border border-transparent hover:border-slate-800"
              >
                <Settings className={`w-5 h-5 ${isProcessing ? 'animate-spin' : ''}`} />
                Nastavení Aplikace
              </button>
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-3 px-3">
            <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-black text-[10px] text-indigo-400">MB</div>
            <div className="flex flex-col">
              <span className="text-xs font-bold text-white leading-none">Martin H.</span>
              <span className="text-[10px] text-slate-500">Premium Plan</span>
            </div>
          </div>
        </div>
      </aside>

      {/* MAIN CONTENT AREA */}
      <main className="flex-1 relative overflow-y-auto overflow-x-hidden flex flex-col no-scrollbar bg-slate-950">
        <div className="max-w-7xl mx-auto w-full px-4 md:px-12 py-6 md:py-10 pb-32 md:pb-12">

          {/* DESKTOP HEADER - Office Style */}
          <header className="hidden md:flex flex-col gap-1 mb-10 border-b border-slate-900 pb-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-3xl font-black text-white uppercase tracking-tight">
                  {navItems.find(i => i.id === viewMode)?.label}
                </h1>
                <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-1">
                  {viewMode === 'battle' ? 'Strategický přehled dne' :
                    viewMode === 'week' ? 'Plánování týdenních cílů' :
                      viewMode === 'google-tasks' ? 'Synchronizace s Google Tasks' :
                        'Správa pracovního workflow'}
                </p>
              </div>

              <div className="flex items-center gap-4">
                <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-2 flex items-center gap-3 w-64">
                  <Clock className="w-4 h-4 text-slate-600" />
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tight">{new Date().toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
                </div>
              </div>
            </div>
          </header>

          {/* MOBILE NAV (Hidden on Tablet/PC) */}
          <nav className="md:hidden flex items-center justify-between bg-slate-900 p-2 mb-6 rounded-2xl border border-slate-800 shadow-xl">
            <div className="flex gap-1 overflow-x-auto no-scrollbar">
              {navItems.filter(i => !i.hideMobile).map((item) => {
                const Icon = item.icon;
                const isActive = viewMode === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setViewMode(item.id as ViewMode)}
                    className={`flex flex-col items-center gap-1 px-4 py-3 rounded-xl transition-all ${isActive ? 'bg-indigo-600 text-white' : 'text-slate-500'}`}
                  >
                    <Icon className="w-6 h-6" />
                  </button>
                );
              })}
            </div>
          </nav>

          {viewMode === 'google-tasks' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex gap-2 p-1 bg-slate-900 border border-slate-800 rounded-2xl overflow-x-auto no-scrollbar">
                  {googleTaskLists.map(list => (
                    <button
                      key={list.id}
                      onClick={() => setActiveTaskList(list.id)}
                      className={`px-5 py-2.5 rounded-xl text-[10px] font-black uppercase whitespace-nowrap transition-all ${activeTaskList === list.id ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      {list.title}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => googleService.getTasks(activeTaskList).then(setGoogleTasksList)}
                  className="p-3 bg-slate-900 border border-slate-800 rounded-xl text-slate-400 hover:text-white transition-all self-end md:self-auto"
                >
                  <Clock className={`w-5 h-5 ${isSyncing ? 'animate-spin' : ''}`} />
                </button>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {googleTasksList.map((gt) => (
                  <motion.div
                    key={gt.id}
                    layout
                    className="p-5 bg-slate-900/50 border border-slate-800 rounded-2xl flex items-center gap-4 group hover:border-indigo-500/30 transition-all shadow-sm"
                  >
                    <button
                      onClick={async () => {
                        const newStatus = gt.status === 'completed' ? 'needsAction' : 'completed';
                        await googleService.updateGoogleTask(gt.id, { status: newStatus }, activeTaskList);
                        googleService.getTasks(activeTaskList).then(setGoogleTasksList);
                      }}
                      className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${gt.status === 'completed' ? 'bg-emerald-600 border-emerald-600' : 'border-slate-700 hover:border-indigo-500'}`}
                    >
                      {gt.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-white" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <h3 className={`text-sm font-bold text-white truncate ${gt.status === 'completed' ? 'line-through opacity-40' : ''}`}>{gt.title}</h3>
                      {gt.notes && <p className="text-[10px] text-slate-500 line-clamp-1 mt-1 font-medium">{gt.notes}</p>}
                    </div>
                  </motion.div>
                ))}
              </div>
              {googleTasksList.length === 0 && (
                <div className="py-20 text-center bg-slate-900/20 rounded-3xl border border-dashed border-slate-800">
                  <CheckCircle2 className="w-12 h-12 text-slate-800 mx-auto mb-4" />
                  <p className="text-slate-500 font-bold uppercase text-[10px] tracking-widest">Žádné úkoly k zobrazení</p>
                </div>
              )}
            </div>
          )}

          {viewMode === 'week' && (
            <div className="mb-8 space-y-6">
              <div className="flex justify-between items-center bg-slate-900/50 p-4 rounded-2xl border border-slate-800">
                <div className="flex items-center gap-4">
                  <LayoutGrid className="w-5 h-5 text-indigo-500" />
                  <h2 className="text-sm font-black text-white uppercase tracking-widest">
                    {new Date(getWeekDays(weekOffset)[0].full).toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' })}
                  </h2>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setWeekOffset(prev => prev - 1)} className="p-2.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white active:scale-95 transition-all"><ChevronLeft className="w-4 h-4" /></button>
                  <button onClick={() => setWeekOffset(0)} className="px-4 py-2 rounded-xl bg-slate-800 text-[10px] font-bold text-white uppercase tracking-widest hover:bg-slate-700 transition-all">Dnes</button>
                  <button onClick={() => setWeekOffset(prev => prev + 1)} className="p-2.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white active:scale-95 transition-all"><ChevronRight className="w-4 h-4" /></button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {getWeekDays(weekOffset).map((day) => {
                  const dayTasks = tasks.filter(t => (t.date === day.full || t.deadline === day.full));
                  return (
                    <div key={day.full} className={`p-6 rounded-2xl border transition-all ${day.isToday ? 'bg-indigo-600/5 border-indigo-500/20 shadow-lg shadow-indigo-600/5' : 'bg-slate-900/40 border-slate-800'}`}>
                      <div className="flex justify-between items-center mb-5 border-b border-slate-800 pb-3">
                        <div className="flex items-center gap-3">
                          <span className={`text-[10px] uppercase font-black tracking-[0.2em] ${day.isToday ? 'text-indigo-400' : 'text-slate-500'}`}>{day.dayName}</span>
                          <span className={`text-xl font-black ${day.isToday ? 'text-white' : 'text-slate-300'}`}>{day.dayNum}</span>
                        </div>
                      </div>
                      <div className="space-y-2">
                        {dayTasks.length === 0 ? <p className="text-[10px] text-slate-700 italic px-1">Žádné plány</p> : dayTasks.map(t => (
                          <button key={t.id} onClick={() => setEditingTask(t)} className={`w-full text-left p-3 rounded-2xl border transition-all flex items-center justify-between relative overflow-hidden ${t.status === 'completed' ? 'opacity-40' : ''} ${t.type === 'meeting' ? 'bg-orange-500/5 border-orange-500/10' : 'bg-indigo-500/5 border-indigo-500/10'}`}>
                            <div className={`absolute inset-0 opacity-10 ${t.type === 'meeting' ? 'bg-orange-400' : 'bg-indigo-400'}`} style={{ width: `${t.progress || 0}%` }} />
                            <div className="flex items-center gap-2 relative z-10">
                              {t.type === 'meeting' ? <Users className="w-3.5 h-3.5 text-orange-400" /> : <List className="w-3.5 h-3.5 text-indigo-400" />}
                              <span className="text-xs font-bold uppercase tracking-tight text-white line-clamp-1">{t.title}</span>
                              {t.googleEventId && <span className="text-[8px] bg-blue-500/20 text-blue-400 px-1 rounded-sm border border-blue-500/30 flex items-center justify-center">G</span>}
                            </div>
                            {t.type === 'meeting' && !t.googleEventId && googleAuth.isSignedIn && (
                              <div className="relative z-20">
                                <button onClick={(e) => { e.stopPropagation(); handleSyncToGoogle(t); }} className="p-1 px-2 bg-blue-500/10 border border-blue-500/30 rounded-lg text-[8px] font-bold text-blue-400 uppercase">Sync</button>
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {viewMode !== 'week' && (
            <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-start">
              <AnimatePresence mode="popLayout">
                {tasks.length === 0 ? (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-20 text-center bg-slate-900/20 rounded-3xl border border-dashed border-slate-800">
                    <AlertCircle className="w-12 h-12 text-slate-800 mx-auto mb-4" />
                    <p className="text-slate-500 font-bold uppercase text-[10px] tracking-widest">Seznam je prázdný</p>
                  </motion.div>
                ) : (
                  tasks.map((task) => (
                    <motion.div
                      key={task.id}
                      layout
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.98 }}
                      className={`p-6 bg-slate-900/40 border border-slate-800 rounded-2xl group transition-all duration-300 hover:border-slate-700 shadow-lg ${task.status === 'completed' ? 'opacity-40 grayscale-[0.5]' : ''}`}
                    >
                      <div className="flex justify-between items-start mb-4">
                        <div className={`text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-md border ${getUrgencyColor(task.urgency)}`}>
                          Přednost {task.urgency}
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={(e) => { e.stopPropagation(); handleExport(task); }} className="p-1.5 rounded-lg bg-slate-800 text-slate-500 hover:text-white transition-all"><Mail className="w-4 h-4" /></button>
                          {task.startTime && (
                            <div className="h-6 px-2 bg-slate-800 rounded-md flex items-center gap-1.5 border border-slate-700">
                              <Clock className="w-3 h-3 text-indigo-400" />
                              <span className="text-[10px] font-black text-white">{task.startTime}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="mb-4">
                        <div className="flex items-start gap-3">
                          <div className={`mt-0.5 p-2 rounded-lg ${task.type === 'meeting' ? 'bg-orange-500/10 text-orange-400' : task.type === 'thought' ? 'bg-yellow-500/10 text-yellow-400' : 'bg-indigo-500/10 text-indigo-400'}`}>
                            {task.type === 'meeting' ? <Users className="w-4 h-4" /> : task.type === 'thought' ? <Lightbulb className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="text-sm font-black text-white uppercase tracking-tight leading-tight mb-1 group-hover:text-indigo-400 transition-colors">{task.title}</h3>
                            <p className="text-xs text-slate-500 line-clamp-2 font-medium leading-relaxed">{task.description}</p>
                          </div>
                        </div>
                      </div>

                      {task.subTasks && task.subTasks.length > 0 && (
                        <div className="space-y-2 mb-6 ml-11">
                          {task.subTasks.slice(0, 3).map(st => (
                            <button key={st.id} onClick={() => toggleSubtask(task, st.id)} className="flex items-center gap-2 group/st w-full">
                              <div className={`w-4 h-4 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${st.completed ? 'bg-indigo-600 border-indigo-600' : 'border-slate-700 group-hover/st:border-indigo-500'}`}>
                                {st.completed && <CheckCircle2 className="w-3 h-3 text-white" />}
                              </div>
                              <span className={`text-[11px] font-bold ${st.completed ? 'text-slate-600 line-through' : 'text-slate-400 group-hover/st:text-slate-200'}`}>{st.title}</span>
                            </button>
                          ))}
                          {task.subTasks.length > 3 && (
                            <div className="text-[10px] text-slate-600 font-bold uppercase">+ {task.subTasks.length - 3} dalších</div>
                          )}
                        </div>
                      )}

                      {task.status === 'pending' && (task.type === 'task' || task.type === 'meeting') && (
                        <div className="mb-8 ml-11">
                          <div className="flex justify-between items-end mb-1.5 px-0.5">
                            <span className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Stav plnění</span>
                            <span className="text-[10px] font-black text-white">{task.progress || 0}%</span>
                          </div>
                          <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                            <motion.div initial={{ width: 0 }} animate={{ width: `${task.progress || 0}%` }} className={`h-full ${task.type === 'meeting' ? 'bg-orange-500 shadow-[0_0_10px_rgba(249,115,22,0.4)]' : 'bg-indigo-600 shadow-[0_0_10px_rgba(79,70,229,0.4)]'}`} />
                          </div>
                        </div>
                      )}

                      <div className="flex gap-2 pt-4 border-t border-slate-800 mt-auto">
                        <button
                          onClick={async () => { if (task.id) await db.tasks.update(task.id, { status: task.status === 'completed' ? 'pending' : 'completed' }); }}
                          className={`h-10 px-4 flex-1 rounded-xl text-[10px] font-black uppercase transition-all flex items-center justify-center gap-2 ${task.status === 'completed' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                        >
                          {task.status === 'completed' ? <CheckCircle2 className="w-3.5 h-3.5" /> : null}
                          {task.status === 'completed' ? 'Dokončeno' : 'Splnit'}
                        </button>
                        <button onClick={() => setEditingTask(task)} className="h-10 px-4 flex-1 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700 text-[10px] font-black uppercase transition-all flex items-center justify-center gap-2">
                          <FileText className="w-3.5 h-3.5" /> Detaily
                        </button>
                        <button onClick={() => { if (activeVoiceUpdateId === task.id) { stopRecording(); } else { setActiveVoiceUpdateId(task.id!); startRecording(); } }} className={`h-10 px-4 rounded-xl transition-all border ${activeVoiceUpdateId === task.id ? 'bg-red-500 border-red-500 text-white' : 'bg-indigo-600/10 border-indigo-600/20 text-indigo-400 hover:bg-indigo-600/20'}`}>
                          <Mic className="w-4 h-4" />
                        </button>
                      </div>
                    </motion.div>
                  ))
                )}
              </AnimatePresence>
            </section>
          )}

          <AnimatePresence>
            {editingTask && (
              <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 bg-slate-950/90 backdrop-blur-sm overflow-y-auto pt-10 pb-10">
                <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} className="w-full max-w-md md:max-w-7xl p-8 space-y-8 my-auto bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl relative overflow-hidden">
                  <div className="absolute top-0 left-0 w-full h-1 bg-indigo-600" />
                  <div className="flex justify-between items-center"><h2 className="text-xl font-black text-white uppercase tracking-tight">Vlastnosti záznamu</h2><button onClick={() => setEditingTask(null)} className="p-2 text-slate-500 hover:text-white transition-colors"><X className="w-6 h-6" /></button></div>
                  <div className="space-y-6 max-h-[75vh] overflow-y-auto custom-scrollbar px-1">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                      <div className="space-y-6">
                        <div className="space-y-3">
                          <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] pl-1">Základní informace</label>
                          <input type="text" value={editingTask.title} onChange={(e) => setEditingTask({ ...editingTask, title: e.target.value })} className="w-full bg-slate-800 border border-slate-700 rounded-xl px-5 py-3.5 text-white font-bold focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition-all" placeholder="Název úkolu..." />
                          <div className="grid grid-cols-12 gap-3">
                            <select value={editingTask.type} onChange={(e) => setEditingTask({ ...editingTask, type: e.target.value as any })} className="col-span-4 bg-slate-800 border border-slate-700 rounded-xl px-2 py-3.5 text-white text-[10px] font-bold uppercase tracking-widest"><option value="task">Úkol</option><option value="meeting">Schůzka</option><option value="thought">Myšlenka</option></select>
                            <input type="date" value={editingTask.date || editingTask.deadline || ''} onChange={(e) => setEditingTask({ ...editingTask, date: e.target.value, deadline: e.target.value })} className="col-span-5 bg-slate-800 border border-slate-700 rounded-xl px-4 py-3.5 text-white text-[10px] font-bold" />
                            <input type="time" value={editingTask.startTime || ''} onChange={(e) => setEditingTask({ ...editingTask, startTime: e.target.value })} className="col-span-3 bg-slate-800 border border-slate-700 rounded-xl px-4 py-3.5 text-white text-[10px] font-bold" />
                          </div>
                        </div>
                        <div className="space-y-3"><label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] pl-1">Podrobný popis</label><textarea rows={4} value={editingTask.description} onChange={(e) => setEditingTask({ ...editingTask, description: e.target.value })} className="w-full bg-slate-800 border border-slate-700 rounded-xl px-5 py-4 text-white text-sm font-medium focus:border-indigo-500 outline-none transition-all" /></div>
                        <div className="space-y-3"><label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] pl-1">Interní poznámky</label><textarea rows={4} value={editingTask.internalNotes || ''} onChange={(e) => setEditingTask({ ...editingTask, internalNotes: e.target.value })} className="w-full bg-slate-800 border border-slate-700 rounded-xl px-5 py-4 text-white text-sm font-medium focus:border-indigo-500 outline-none transition-all" /></div>
                      </div>

                      <div className="hidden md:flex flex-col space-y-6 border-l border-slate-800 pl-10">
                        <div className="flex justify-between items-center">
                          <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Checklist / Postup</label>
                          <button
                            onClick={() => {
                              const newSubTasks = [...(editingTask.subTasks || []), { id: Date.now().toString(), title: '', completed: false }];
                              setEditingTask({ ...editingTask, subTasks: newSubTasks });
                            }}
                            className="text-[10px] bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg transition-all font-black uppercase tracking-widest shadow-lg shadow-indigo-600/20"
                          >
                            + Nový bod
                          </button>
                        </div>
                        <div className="space-y-3 max-h-[450px] overflow-y-auto no-scrollbar pr-2">
                          {editingTask.subTasks?.map((st) => (
                            <div key={st.id} className="flex gap-4 items-start group bg-slate-800/40 p-3 rounded-xl border border-slate-800 hover:border-slate-700 transition-all">
                              <button
                                onClick={() => {
                                  const newSubTasks = editingTask.subTasks?.map(item => item.id === st.id ? { ...item, completed: !item.completed } : item);
                                  setEditingTask({ ...editingTask, subTasks: newSubTasks });
                                }}
                                className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center shrink-0 mt-0.5 transition-all ${st.completed ? 'bg-indigo-600 border-indigo-600 shadow-lg shadow-indigo-600/30' : 'bg-slate-900 border-slate-700 hover:border-indigo-500'}`}
                              >
                                {st.completed && <CheckCircle2 className="w-4 h-4 text-white" />}
                              </button>
                              <textarea
                                value={st.title}
                                rows={1}
                                onChange={(e) => {
                                  const newSubTasks = editingTask.subTasks?.map(item => item.id === st.id ? { ...item, title: e.target.value } : item);
                                  setEditingTask({ ...editingTask, subTasks: newSubTasks });
                                }}
                                className={`bg-transparent border-none focus:ring-0 rounded-lg px-2 py-1 text-sm flex-1 text-white resize-none min-h-[32px] w-full overflow-hidden ${st.completed ? 'line-through text-slate-500' : 'font-bold'}`}
                                placeholder="Název kroku..."
                                onInput={(e) => {
                                  const target = e.target as HTMLTextAreaElement;
                                  target.style.height = 'auto';
                                  target.style.height = target.scrollHeight + 'px';
                                }}
                              />
                              <button
                                onClick={() => {
                                  const newSubTasks = editingTask.subTasks?.filter(item => item.id !== st.id);
                                  setEditingTask({ ...editingTask, subTasks: newSubTasks });
                                }}
                                className="p-2 text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all self-center"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                          {(!editingTask.subTasks || editingTask.subTasks.length === 0) && (
                            <p className="text-[10px] text-slate-600 font-bold uppercase text-center py-10 opacity-50 tracking-[0.2em]">Žádné kroky definovány</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="pt-8 flex flex-row gap-4 items-center border-t border-slate-800">
                    {/* Smazat - samostatně vlevo pro bezpečnost */}
                    <button
                      onClick={async () => {
                        if (editingTask.id) {
                          if (!confirm("Opravdu smazat?")) return;
                          let calendarDeleted = false;
                          if (editingTask.googleEventId && googleAuth.isSignedIn) {
                            try {
                              await googleService.deleteFromCalendar(editingTask.googleEventId);
                              calendarDeleted = true;
                            } catch (e: any) {
                              alert("Nepodařilo se smazat z kalendáře: " + e.message);
                            }
                          }
                          await db.tasks.delete(editingTask.id);
                          if (calendarDeleted) alert("Smazáno z aplikace i z Google Kalendáře.");
                        }
                        setEditingTask(null);
                      }}
                      className="px-4 py-4 rounded-2xl bg-red-600/20 border border-red-500/30 text-red-500 text-[10px] font-black uppercase hover:bg-red-600 hover:text-white transition-all flex items-center gap-2 shadow-lg shadow-red-500/10 active:scale-95 transition-all"
                      title="Smazat záznam"
                    >
                      <X className="w-4 h-4" />
                      <span>Smazat</span>
                    </button>

                    {/* Velká mezera pro oddělení od palce (uložit/synchronizovat) */}
                    <div className="flex-1" />

                    <div className="flex flex-row gap-2 md:gap-4 shrink-0">
                      {editingTask.type === 'meeting' && googleAuth.isSignedIn && (
                        <button
                          onClick={() => handleSyncToGoogle(editingTask)}
                          className={`py-4 px-4 md:px-8 rounded-2xl border text-[10px] font-bold uppercase transition-all flex items-center justify-center gap-2 ${editingTask.googleEventId ? 'bg-emerald-600 border-emerald-500 text-white shadow-lg shadow-emerald-500/20' : 'bg-emerald-600/20 border-emerald-500/30 text-emerald-400 hover:bg-emerald-600 hover:text-white'}`}
                        >
                          <Share2 className="w-4 h-4" />
                          <span className="hidden sm:inline">{editingTask.googleEventId ? 'Aktualizovat' : 'Sdílet'}</span>
                        </button>
                      )}

                      <button
                        onClick={handleSaveEdit}
                        className="py-4 px-8 md:px-16 bg-orange-600 hover:bg-orange-500 text-white font-black uppercase text-xs rounded-2xl flex items-center justify-center gap-2 shadow-lg shadow-orange-600/25 transition-all active:scale-95 whitespace-nowrap"
                      >
                        <Save className="w-4 h-4" />
                        <span className="hidden xs:inline">Uložit</span>
                      </button>
                    </div>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {showSettings && (
              <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 bg-slate-950/95 backdrop-blur-md">
                <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 50, opacity: 0 }} className="glass-card w-full max-w-sm p-8 space-y-6">
                  <div className="flex justify-between items-center"><h2 className="text-2xl font-display font-bold text-white">Nastavení AI</h2><button onClick={() => setShowSettings(false)} className="text-slate-500"><X /></button></div>
                  <div className="space-y-4">
                    <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-4 text-white text-sm" placeholder="Gemini API klíč..." />
                    <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-2xl px-4 py-4 text-white text-sm">{availableModels.map(m => <option key={m} value={m}>{m}</option>)}</select>
                    <div className="pt-4 border-t border-white/5 space-y-3">
                      <h3 className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">Vzhled a Čitelnost</h3>
                      <div className="p-4 bg-white/5 rounded-2xl border border-white/10 space-y-4">
                        <div className="flex justify-between items-center text-[10px] font-bold text-slate-400 uppercase">
                          <span>Velikost písma</span>
                          <span className="text-white px-2 py-0.5 bg-indigo-500/20 rounded-md border border-indigo-500/30">{uiScale}px</span>
                        </div>
                        <input
                          type="range"
                          min="12"
                          max="24"
                          step="1"
                          value={uiScale}
                          onChange={(e) => setUiScale(Number(e.target.value))}
                          className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                        />
                        <div className="flex justify-between text-[8px] text-slate-600 font-bold uppercase">
                          <span>Malé</span>
                          <span>Normální (16)</span>
                          <span>Velké</span>
                        </div>
                      </div>
                    </div>

                    <div className="pt-4 border-t border-white/5 space-y-3">
                      {googleAuth.isSignedIn ? (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl">
                            <span className="text-xs text-emerald-400 font-bold">Připojeno</span>
                            <button onClick={() => googleService.signOut()} className="text-[10px] text-slate-500 uppercase underline">Odpojit</button>
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <button
                              onClick={handleBackupToDrive}
                              disabled={isSyncing}
                              className="flex flex-col items-center justify-center p-4 bg-indigo-600/10 border border-indigo-500/20 rounded-2xl text-indigo-300 transition-all hover:bg-indigo-600/20 disabled:opacity-50"
                            >
                              <CloudUpload className={`w-5 h-5 mb-1 ${isSyncing ? 'animate-bounce' : ''}`} />
                              <span className="text-[10px] font-bold uppercase">Zálohovat</span>
                            </button>
                            <button
                              onClick={handleRestoreFromDrive}
                              disabled={isSyncing}
                              className="flex flex-col items-center justify-center p-4 bg-blue-500/10 border border-blue-500/20 rounded-2xl text-blue-300 transition-all hover:bg-blue-500/20 disabled:opacity-50"
                            >
                              <CloudDownload className="w-5 h-5 mb-1" />
                              <span className="text-[10px] font-bold uppercase">Obnovit</span>
                            </button>
                          </div>

                          {lastSync && (
                            <p className="text-center text-[9px] text-slate-600 font-mono">
                              Poslední synchronizace: {lastSync}
                            </p>
                          )}
                        </div>
                      ) : <button onClick={() => googleService.signIn()} className="w-full py-4 bg-white text-slate-900 rounded-2xl text-xs font-bold uppercase flex items-center justify-center gap-2 font-black">Google Přihlášení</button>}
                    </div>
                  </div>
                  <button onClick={saveSettings} className="w-full py-4 bg-indigo-600 rounded-2xl text-white font-bold uppercase text-xs flex items-center justify-center gap-2"><Save className="w-4 h-4" /> Uložit nastavení</button>
                </motion.div>
              </div>
            )}
          </AnimatePresence>
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 md:left-auto md:right-10 md:translate-x-0 z-[100]">
            <div className="relative">
              <AnimatePresence>
                {isRecording && <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1.6, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} className={`absolute inset-0 ${activeVoiceUpdateId ? 'bg-red-500/40' : 'bg-indigo-500/30'} rounded-full blur-3xl animate-pulse`} />}
              </AnimatePresence>
              <button onClick={isRecording ? stopRecording : () => { setActiveVoiceUpdateId(null); startRecording(); }} disabled={isProcessing} className={`relative z-10 w-20 h-20 md:w-24 md:h-24 rounded-full flex items-center justify-center transition-all shadow-2xl ${isRecording ? 'bg-red-500 scale-110 shadow-red-500/50' : isProcessing ? 'bg-slate-800' : 'bg-indigo-600 shadow-indigo-600/50 hover:scale-105'}`}>
                {isProcessing ? <div className="w-8 h-8 md:w-10 md:h-10 border-4 border-slate-500 border-t-white rounded-full animate-spin" /> : (isRecording ? <MicOff className="w-8 h-8 md:w-10 md:h-10 text-white" /> : <Mic className="w-8 h-8 md:w-10 md:h-10 text-white" />)}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
