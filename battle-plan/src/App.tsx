import { useState, useEffect } from 'react';
import { Mic, MicOff, CheckCircle2, AlertCircle, FileText, Share2, List, Users, Lightbulb, Save, X, Clock, Settings, ChevronLeft, ChevronRight, LayoutGrid, Mail } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAudioRecorder } from './hooks/useAudioRecorder';
import { db, type Task } from './db';
import { useLiveQuery } from 'dexie-react-hooks';
import { geminiService } from './services/geminiService';
import { googleService, type GoogleAuthStatus } from './services/googleService';

type ViewMode = 'battle' | 'week' | 'tasks' | 'meetings' | 'thoughts';

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

  const getTimeRemaining = (deadline?: string) => {
    if (!deadline) return null;
    const diff = new Date(deadline).getTime() - new Date().getTime();
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    return days > 0 ? `${days}d` : 'Dnes!';
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
    { id: 'meetings', label: 'Schůzky', icon: Users },
    { id: 'thoughts', label: 'Myšlenky', icon: Lightbulb },
  ];

  return (
    <div className="max-w-md mx-auto px-4 py-6 pb-32 min-h-screen">
      <nav className="sticky top-0 z-50 flex justify-between bg-slate-950/80 backdrop-blur-md p-2 mb-8 rounded-2xl border border-white/5 shadow-xl">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = viewMode === item.id;
          return (
            <button key={item.id} onClick={() => setViewMode(item.id as ViewMode)} className={`flex flex-col items-center gap-1 px-3 py-2 rounded-xl transition-all duration-300 ${isActive ? 'bg-indigo-600/20 text-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}>
              <Icon className={`w-5 h-5 ${isActive ? 'scale-110' : ''}`} />
              <span className="text-[10px] font-medium uppercase tracking-tighter">{item.label}</span>
              {isActive && <motion.div layoutId="nav-underline" className="w-1 h-1 bg-indigo-500 rounded-full mt-0.5" />}
            </button>
          );
        })}
      </nav>

      <header className="mb-6 px-2 flex justify-between items-end">
        <div>
          <h1 className="text-3xl premium-gradient-text uppercase tracking-tight">{navItems.find(i => i.id === viewMode)?.label}</h1>
          <p className="text-slate-500 text-xs">AI Systém aktivní.</p>
        </div>
        <button onClick={() => setShowSettings(true)} className="p-2 rounded-full bg-white/5 text-slate-400 hover:text-white transition-all">
          <Settings className="w-5 h-5" />
        </button>
      </header>

      {viewMode === 'week' && (
        <div className="mb-8 space-y-4">
          <div className="flex justify-between items-center px-1 mb-4">
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">
              {new Date(getWeekDays(weekOffset)[0].full).toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' })}
            </h2>
            <div className="flex gap-2">
              <button onClick={() => setWeekOffset(prev => prev - 1)} className="p-2 rounded-xl bg-white/5 text-slate-400 active:scale-95"><ChevronLeft className="w-4 h-4" /></button>
              <button onClick={() => setWeekOffset(0)} className="px-3 py-1 rounded-xl bg-white/5 text-[10px] font-bold text-slate-400 uppercase">Dnes</button>
              <button onClick={() => setWeekOffset(prev => prev + 1)} className="p-2 rounded-xl bg-white/5 text-slate-400 active:scale-95"><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>

          <div className="space-y-4">
            {getWeekDays(weekOffset).map((day) => {
              const dayTasks = tasks.filter(t => (t.date === day.full || t.deadline === day.full));
              return (
                <div key={day.full} className={`p-4 rounded-3xl border transition-all ${day.isToday ? 'bg-indigo-500/5 border-indigo-500/20' : 'bg-white/2 border-white/5'}`}>
                  <div className="flex justify-between items-center mb-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] uppercase font-black tracking-widest ${day.isToday ? 'text-indigo-400' : 'text-slate-600'}`}>{day.dayName}</span>
                      <span className={`text-lg font-display font-black ${day.isToday ? 'text-white' : 'text-slate-400'}`}>{day.dayNum}</span>
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
        <section className="space-y-4">
          <AnimatePresence mode="popLayout">
            {tasks.length === 0 ? (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="glass-card p-12 text-center">
                <AlertCircle className="w-10 h-10 text-slate-700 mx-auto mb-4" />
                <p className="text-slate-500 text-sm italic">Prázdnota. Něco jí řekněte.</p>
              </motion.div>
            ) : (
              tasks.map((task) => (
                <motion.div key={task.id} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} className={`glass-card p-5 group transition-all duration-300 ${task.status === 'completed' ? 'opacity-40' : ''}`}>
                  <div className="flex justify-between items-start mb-3">
                    <div className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full border ${getUrgencyColor(task.urgency)}`}>Urgence {task.urgency}</div>
                    <div className="flex items-center gap-2">
                      <button onClick={(e) => { e.stopPropagation(); handleExport(task); }} className="p-1.5 rounded-xl bg-white/5 text-slate-500 hover:text-indigo-400 hover:bg-indigo-400/10 transition-all"><Mail className="w-3.5 h-3.5" /></button>
                      <span className="text-slate-500 text-[10px] font-medium flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {task.startTime && <span className="text-white font-bold">{task.startTime}</span>}
                        {getTimeRemaining(task.deadline || task.date)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mb-1">
                    {task.type === 'meeting' && <Users className="w-4 h-4 text-orange-400" />}
                    {task.type === 'thought' && <Lightbulb className="w-4 h-4 text-yellow-400" />}
                    {task.type === 'task' && <CheckCircle2 className="w-4 h-4 text-blue-400" />}
                    <h3 className="text-md font-semibold text-slate-100 uppercase tracking-tight">{task.title}</h3>
                    <div className="ml-auto flex items-center gap-2">
                      <span className="text-[8px] text-slate-600 font-mono">id:{task.id} | type:{task.type}</span>

                      {(task.type === 'meeting' || task.type === 'task') && googleAuth.isSignedIn && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleSyncToGoogle(task); }}
                          className={`p-1.5 rounded-lg border transition-all flex items-center gap-1 ${task.googleEventId ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-blue-500/10 border-blue-500/20 text-blue-400'}`}
                          title={task.googleEventId ? "Aktualizovat v kalendáři" : "Odeslat do kalendáře"}
                        >
                          <Share2 className="w-3 h-3" />
                          <span className="text-[9px] font-bold uppercase">{task.googleEventId ? 'Sync' : 'Odeslat'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-slate-400 text-sm mb-2 line-clamp-1 leading-relaxed">{task.description}</p>

                  {task.subTasks && task.subTasks.length > 0 && (
                    <div className="space-y-1 mb-4">
                      {task.subTasks.slice(0, 3).map(st => (
                        <button key={st.id} onClick={() => toggleSubtask(task, st.id)} className="flex items-center gap-2 text-[11px] text-slate-400 w-full text-left">
                          <div className={`w-3.5 h-3.5 rounded-md border border-white/20 flex items-center justify-center shrink-0 ${st.completed ? 'bg-indigo-500 border-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.4)]' : 'bg-white/5'}`}>
                            {st.completed && <CheckCircle2 className="w-2.5 h-2.5 text-white" />}
                          </div>
                          <span className={st.completed ? 'line-through opacity-50' : ''}>{st.title}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {task.status === 'pending' && (task.type === 'task' || task.type === 'meeting') && (
                    <div className="space-y-3 mb-5 mt-4">
                      <div className="space-y-1">
                        <div className="flex justify-between text-[10px] font-bold text-slate-500 uppercase"><span>Pokrok</span><span>{task.progress || 0}%</span></div>
                        <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden border border-white/5">
                          <motion.div initial={{ width: 0 }} animate={{ width: `${task.progress || 0}%` }} className={`h-full ${task.type === 'meeting' ? 'bg-orange-500' : 'bg-indigo-500'}`} />
                        </div>
                      </div>

                      {/* Sync button moved to header */}
                    </div>
                  )}

                  <div className="flex gap-2 mt-4">
                    <button onClick={async () => { if (task.id) await db.tasks.update(task.id, { status: task.status === 'completed' ? 'pending' : 'completed' }); }} className={`glass-button py-2 px-3 text-[11px] flex-1 ${task.status === 'completed' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/5'}`}>
                      <CheckCircle2 className="w-3.5 h-3.5" /> {task.status === 'completed' ? 'Splněno' : 'Splnit'}
                    </button>
                    <button onClick={() => setEditingTask(task)} className="glass-button py-2 px-3 text-[11px] flex-1"><FileText className="w-3.5 h-3.5" /> Upravit</button>
                    <button onClick={() => { if (activeVoiceUpdateId === task.id) { stopRecording(); } else { setActiveVoiceUpdateId(task.id!); startRecording(); } }} className={`glass-button py-2 px-3 text-[11px] flex-1 ${activeVoiceUpdateId === task.id ? 'bg-red-500 text-white' : 'text-indigo-400'}`}>
                      <Mic className="w-3.5 h-3.5" /> Hlasem
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
          <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 bg-slate-950/90 backdrop-blur-sm overflow-y-auto pt-20 pb-10">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} className="glass-card w-full max-w-md p-6 space-y-5 my-auto">
              <div className="flex justify-between items-center"><h2 className="text-xl font-bold text-white uppercase tracking-tight">Detail záznamu</h2><button onClick={() => setEditingTask(null)} className="p-2 text-slate-500 hover:text-white"><X /></button></div>
              <div className="space-y-4 max-h-[60vh] overflow-y-auto px-1">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest pl-1">Název</label>
                  <input type="text" value={editingTask.title} onChange={(e) => setEditingTask({ ...editingTask, title: e.target.value })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none" />
                  <div className="grid grid-cols-12 gap-2">
                    <select value={editingTask.type} onChange={(e) => setEditingTask({ ...editingTask, type: e.target.value as any })} className="col-span-4 bg-slate-900 border border-white/10 rounded-xl px-2 py-3 text-white text-[10px]"><option value="task">Úkol</option><option value="meeting">Schůzka</option><option value="thought">Myšlenka</option></select>
                    <input type="date" value={editingTask.date || editingTask.deadline || ''} onChange={(e) => setEditingTask({ ...editingTask, date: e.target.value, deadline: e.target.value })} className="col-span-5 bg-slate-900 border border-white/10 rounded-xl px-2 py-3 text-white text-[10px]" />
                    <input type="time" value={editingTask.startTime || ''} onChange={(e) => setEditingTask({ ...editingTask, startTime: e.target.value })} className="col-span-3 bg-slate-900 border border-white/10 rounded-xl px-2 py-3 text-white text-[10px]" />
                  </div>
                </div>
                <div className="space-y-2"><label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest pl-1">Popis</label><textarea rows={3} value={editingTask.description} onChange={(e) => setEditingTask({ ...editingTask, description: e.target.value })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm" /></div>
                <div className="space-y-2"><label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest pl-1">Interní poznámky</label><textarea rows={3} value={editingTask.internalNotes || ''} onChange={(e) => setEditingTask({ ...editingTask, internalNotes: e.target.value })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm" /></div>

                {googleAuth.isSignedIn && (
                  <div className="pt-2 p-3 bg-blue-500/5 rounded-2xl border border-blue-500/10">
                    <p className="text-[9px] text-blue-400/50 uppercase font-bold mb-2 text-center">Debug: Google Sync</p>
                    <button onClick={() => handleSyncToGoogle(editingTask)} className={`w-full py-3 rounded-xl border text-[10px] font-bold uppercase transition-all flex items-center justify-center gap-2 ${editingTask.googleEventId ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-blue-500/10 border-blue-500/20 text-blue-400'}`}>
                      <Share2 className="w-4 h-4" />
                      {editingTask.googleEventId ? 'Aktualizovat v kalendáři' : 'Odeslat do Kalendáře'}
                    </button>
                  </div>
                )}
              </div>
              <div className="pt-2 flex flex-col gap-2">
                <button onClick={handleSaveEdit} className="w-full py-4 bg-indigo-600 hover:bg-indigo-500 text-white font-bold uppercase text-xs rounded-2xl flex items-center justify-center gap-2"><Save className="w-4 h-4" /> Uložit vše</button>
                <button
                  onClick={async () => {
                    if (editingTask.id) {
                      if (editingTask.googleEventId && googleAuth.isSignedIn) {
                        try { await googleService.deleteFromCalendar(editingTask.googleEventId); } catch (e) { console.error(e); }
                      }
                      await db.tasks.delete(editingTask.id);
                    }
                    setEditingTask(null);
                  }}
                  className="w-full py-2 text-[10px] text-red-500/50 uppercase"
                >
                  Smazat
                </button>
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
                  <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Google Integrace</h3>
                  {googleAuth.isSignedIn ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl">
                        <span className="text-xs text-emerald-400 font-bold">Připojeno</span>
                        <button onClick={() => googleService.signOut()} className="text-[10px] text-slate-500 uppercase underline">Odpojit</button>
                      </div>
                      <button onClick={async () => { const all = await db.tasks.toArray(); await googleService.saveToDrive(all); alert('Záloha uložena'); }} className="w-full py-3 bg-indigo-600/20 text-indigo-300 rounded-xl text-xs font-bold border border-indigo-500/30">Zálohovat na Disk</button>
                    </div>
                  ) : <button onClick={() => googleService.signIn()} className="w-full py-4 bg-white text-slate-900 rounded-2xl text-xs font-bold uppercase flex items-center justify-center gap-2 font-black">Google Přihlášení</button>}
                </div>
              </div>
              <button onClick={saveSettings} className="w-full py-4 bg-indigo-600 rounded-2xl text-white font-bold uppercase text-xs flex items-center justify-center gap-2"><Save className="w-4 h-4" /> Uložit nastavení</button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <div className="fixed bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-slate-950 via-slate-950/95 to-transparent">
        <div className="max-w-md mx-auto flex items-center justify-center gap-6">
          <button onClick={() => setViewMode('thoughts')} className="p-4 rounded-full bg-slate-900/50 border border-white/5 text-slate-400"><Lightbulb className="w-6 h-6" /></button>
          <div className="relative">
            <AnimatePresence>
              {isRecording && <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1.6, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} className={`absolute inset-0 ${activeVoiceUpdateId ? 'bg-red-500/40' : 'bg-indigo-500/30'} rounded-full blur-3xl animate-pulse`} />}
            </AnimatePresence>
            <button onClick={isRecording ? stopRecording : () => { setActiveVoiceUpdateId(null); startRecording(); }} disabled={isProcessing} className={`relative z-10 w-24 h-24 rounded-full flex items-center justify-center transition-all ${isRecording ? 'bg-red-500 scale-110' : isProcessing ? 'bg-slate-800' : 'bg-indigo-600'}`}>
              {isProcessing ? <div className="w-10 h-10 border-4 border-slate-500 border-t-white rounded-full animate-spin" /> : (isRecording ? <MicOff className="w-10 h-10 text-white" /> : <Mic className="w-10 h-10 text-white" />)}
            </button>
          </div>
          <button onClick={() => setViewMode('week')} className="p-4 rounded-full bg-slate-900/50 border border-white/5 text-slate-400"><LayoutGrid className="w-6 h-6" /></button>
        </div>
        <div className="text-center mt-4">
          <span className="text-[8px] text-slate-700 uppercase font-bold tracking-widest">Bitevní Plán v1.2-DEBUG | {new Date().toLocaleTimeString()}</span>
        </div>
      </div>
    </div>
  );
}

export default App;
