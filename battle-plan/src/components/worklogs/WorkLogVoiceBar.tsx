import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Loader2, AlertCircle } from 'lucide-react';
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
}

const hasMediaRecorderSupport = (): boolean =>
    typeof window !== 'undefined' &&
    'MediaRecorder' in window &&
    !!navigator.mediaDevices?.getUserMedia;

export function WorkLogVoiceBar({ onSaved, onError, onInfo }: WorkLogVoiceBarProps) {
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
    const processingRef = useRef(false);
    const [probeError, setProbeError] = useState<string | null>(() =>
        hasMediaRecorderSupport() ? null : 'Tento prohlížeč nepodporuje MediaRecorder',
    );

    const handleToggle = useCallback(async () => {
        if (isRecording) {
            stopRecording();
            return;
        }
        try {
            await startRecording();
            setProbeError(null);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Nepodařilo se spustit mikrofon';
            onError?.(`Mikrofon: ${message}`);
            setProbeError(message);
        }
    }, [isRecording, startRecording, stopRecording, onError]);

    useEffect(() => {
        if (!audioBlob) return;
        if (processingRef.current) return;
        processingRef.current = true;
        setProcessing(true);

        (async () => {
            const apiKey = (await db.settings.get('gemini_api_key'))?.value ?? '';
            if (!apiKey) {
                onError?.('Gemini API klíč chybí. Nastav ho v Konfiguraci.');
                clearAudio();
                processingRef.current = false;
                setProcessing(false);
                return;
            }

            const result = await processWorkLogAudio(audioBlob);
            if (!result.ok) {
                onError?.(`AI extrakce selhala: ${result.error}`);
                clearAudio();
                processingRef.current = false;
                setProcessing(false);
                return;
            }

            setExtracted(result.data);
            clearAudio();
            processingRef.current = false;
            setProcessing(false);
            const totalHours = result.data.entries.reduce((sum, entry) => sum + entry.hours, 0);
            onInfo?.(`Diktování rozpoznáno — ${result.data.entries.length} návrhů, ${totalHours.toFixed(2)} h.`);
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
