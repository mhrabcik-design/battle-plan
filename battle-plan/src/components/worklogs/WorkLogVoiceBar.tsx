import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Loader2, AlertCircle, CalendarDays, Clock3, Users, Briefcase, ClipboardList } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAudioRecorder } from '../../hooks/useAudioRecorder';
import {
    processWorkLogAudio,
    type ApplyResult,
    type ExtractedWorkLogBatch,
} from '../../services/workLogExtractor';
import { db, type WorkLog } from '../../db';
import { WorkLogVoiceConfirm } from './WorkLogVoiceConfirm';

interface WorkLogVoiceBarProps {
    onSaved?: (log: WorkLog) => void;
    onError?: (message: string) => void;
    onInfo?: (message: string) => void;
    onControllerChange?: (controller: WorkLogVoiceController | null) => void;
}

export interface WorkLogVoiceController {
    toggle: () => Promise<void>;
    isRecording: boolean;
    processing: boolean;
    disabled: boolean;
}

const hasMediaRecorderSupport = (): boolean =>
    typeof window !== 'undefined' &&
    'MediaRecorder' in window &&
    !!navigator.mediaDevices?.getUserMedia;

const guidanceItems = [
    { icon: Briefcase, text: 'projekt nebo zakázku' },
    { icon: CalendarDays, text: 'datum nebo období' },
    { icon: Users, text: 'kdo tam pracoval' },
    { icon: Clock3, text: 'kolik hodin na osobu nebo celkem' },
    { icon: ClipboardList, text: 'co se dělalo' },
];

export function WorkLogVoiceBar({ onSaved, onError, onInfo, onControllerChange }: WorkLogVoiceBarProps) {
    const {
        isRecording,
        audioBlob,
        startRecording,
        stopRecording,
        clearAudio,
    } = useAudioRecorder();
    const [processing, setProcessing] = useState(false);
    const [extracted, setExtracted] = useState<ExtractedWorkLogBatch | null>(null);
    const [manualProjectRequired, setManualProjectRequired] = useState(false);
    const [showRecordingGuide, setShowRecordingGuide] = useState(false);
    const processingRef = useRef(false);
    const [probeError, setProbeError] = useState<string | null>(() =>
        hasMediaRecorderSupport() ? null : 'Tento prohlížeč nepodporuje MediaRecorder',
    );

    const handleToggle = useCallback(async () => {
        if (isRecording) {
            setShowRecordingGuide(false);
            stopRecording();
            return;
        }
        try {
            setShowRecordingGuide(true);
            await startRecording();
            setProbeError(null);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Nepodařilo se spustit mikrofon';
            onError?.(`Mikrofon: ${message}`);
            setProbeError(message);
            setShowRecordingGuide(false);
        }
    }, [isRecording, startRecording, stopRecording, onError]);

    useEffect(() => {
        if (!audioBlob) return;
        if (processingRef.current) return;
        setShowRecordingGuide(false);
        processingRef.current = true;
        setProcessing(true);

        (async () => {
            try {
                const apiKey = (await db.settings.get('gemini_api_key'))?.value ?? '';
                if (!apiKey) {
                    onError?.('Gemini API klíč chybí. Nastav ho v Konfiguraci.');
                    return;
                }

                const result = await processWorkLogAudio(audioBlob);
                if (!result.ok) {
                    onError?.(`AI extrakce selhala: ${result.error}`);
                    return;
                }

                setExtracted(result.data);
                const totalHours = result.data.entries.reduce((sum, entry) => sum + entry.hours, 0);
                onInfo?.(`Diktování rozpoznáno — ${result.data.entries.length} návrhů, ${totalHours.toFixed(2)} h.`);
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Neznámá chyba';
                onError?.(`AI extrakce selhala: ${message}`);
            } finally {
                clearAudio();
                processingRef.current = false;
                setProcessing(false);
            }
        })();

        return () => {
            processingRef.current = false;
        };
    }, [audioBlob, clearAudio, onError, onInfo]);

    const handleConfirmed = useCallback(
        (result: ApplyResult) => {
            // Diskriminace přes 'workLog' / 'needsProject' / 'error' (ApplyResult je union)
            if ('workLog' in result) {
                if (result.workLogs.length > 1) {
                    const totalHours = result.workLogs.reduce((sum, log) => sum + log.hours, 0);
                    onInfo?.(`Uloženo ${result.workLogs.length} záznamů práce (${totalHours.toFixed(2)} h).`);
                }
                onSaved?.(result.workLog);
                setExtracted(null);
                setManualProjectRequired(false);
                return;
            }
            if ('needsProject' in result) {
                setExtracted({
                    entries: [result.extracted],
                    assumptions: result.extracted.assumptions ?? [],
                    needsConfirmation: true,
                    confirmationReasons: ['AI nerozpoznalo projekt. Vyber ho v otevřeném okně.'],
                });
                setManualProjectRequired(true);
                onInfo?.('AI nerozpoznalo projekt. Vyber ho v otevřeném okně.');
                return;
            }
            if ('error' in result) {
                onError?.(`Uložení selhalo: ${result.error}`);
            } else {
                onError?.('Uložení selhalo.');
            }
            setExtracted(null);
            setManualProjectRequired(false);
        },
        [onSaved, onError, onInfo],
    );

    const disabled = !hasMediaRecorderSupport() || processing;
    const controller = useMemo<WorkLogVoiceController>(
        () => ({
            toggle: handleToggle,
            isRecording,
            processing,
            disabled,
        }),
        [handleToggle, isRecording, processing, disabled],
    );

    useEffect(() => {
        onControllerChange?.(controller);
    }, [controller, onControllerChange]);

    useEffect(() => {
        return () => onControllerChange?.(null);
    }, [onControllerChange]);

    const title = !hasMediaRecorderSupport()
        ? 'Tvůj prohlížeč nepodporuje MediaRecorder'
        : processing
        ? 'AI zpracovává diktát…'
        : isRecording
        ? 'Zastavit nahrávání a parsovat diktát'
        : 'Nadiktovat pracovní činnost';

    return (
        <>
            <button
                type="button"
                onClick={handleToggle}
                disabled={disabled}
                aria-label={isRecording ? 'Zastavit nahrávání' : 'Spustit diktování'}
                title={title}
                className={`relative flex items-center gap-2 px-4 py-2.5 text-xs font-black uppercase tracking-widest rounded-xl transition-all ${
                    isRecording
                        ? 'bg-red-600 hover:bg-red-500 text-white ring-2 ring-red-300/50'
                        : processing
                        ? 'bg-slate-800 text-slate-400 cursor-wait'
                        : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                }`}
            >
                {processing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                ) : isRecording ? (
                    <motion.span
                        className="inline-block w-2 h-2 rounded-full bg-white"
                        animate={{ opacity: [1, 0.35, 1] }}
                        transition={{ repeat: Infinity, duration: 1 }}
                    />
                ) : (
                    <Mic className="w-4 h-4" />
                )}
                <span>
                    {processing ? 'Parsuji…' : isRecording ? 'Zastavit' : 'Diktovat'}
                </span>
            </button>

            {showRecordingGuide && (
                <motion.div
                    initial={{ opacity: 0, y: 12, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 12, scale: 0.98 }}
                    className="fixed left-3 right-3 bottom-24 md:left-auto md:right-8 md:bottom-8 md:w-[26rem] z-[80] rounded-2xl border border-indigo-400/30 bg-slate-950/95 shadow-2xl shadow-indigo-950/40 backdrop-blur-xl p-4"
                >
                    <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-500/15 text-red-300 ring-1 ring-red-400/30">
                            <motion.span
                                className="h-2.5 w-2.5 rounded-full bg-red-400"
                                animate={{ opacity: [1, 0.35, 1] }}
                                transition={{ repeat: Infinity, duration: 1 }}
                            />
                        </div>
                        <div className="min-w-0 space-y-3">
                            <div>
                                <p className="text-xs font-black uppercase tracking-widest text-indigo-200">
                                    {isRecording ? 'Řekni pracovní záznam' : 'Připravuji mikrofon'}
                                </p>
                                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                                    Nejlépe funguje jedna souvislá věta se zakázkou, lidmi, časem a činností.
                                </p>
                            </div>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                {guidanceItems.map(({ icon: Icon, text }) => (
                                    <div key={text} className="flex items-center gap-2 text-xs font-bold text-slate-300">
                                        <Icon className="h-3.5 w-3.5 text-indigo-300" />
                                        <span>{text}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                                    Příklad
                                </p>
                                <p className="mt-1 text-xs leading-relaxed text-slate-300">
                                    Dnes na projektu Plaza jsme byli Martin a Sergej, každý 8 hodin, montovali jsme kabeláž.
                                </p>
                            </div>
                        </div>
                    </div>
                </motion.div>
            )}

            {manualProjectRequired && (
                <div className="text-[10px] text-amber-400 uppercase tracking-widest font-bold">
                    AI nerozpoznalo projekt — vyber ručně v okně
                </div>
            )}

            {probeError && (
                <div className="flex items-center gap-1.5 text-amber-400 text-[10px] uppercase tracking-widest font-bold">
                    <AlertCircle className="w-3.5 h-3.5" />
                    Mikrofon nedostupný v tomto prohlížeči
                </div>
            )}

            {extracted && (
                <WorkLogVoiceConfirm
                    extracted={extracted}
                    onConfirmed={handleConfirmed}
                    onCancelled={() => {
                        setExtracted(null);
                        setManualProjectRequired(false);
                    }}
                />
            )}
        </>
    );
}
