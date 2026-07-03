import { useCallback, useEffect, type MutableRefObject } from 'react';
import { geminiService } from '../services/geminiService';
import { processWorkLogAudio, type ExtractedWorkLogBatch } from '../services/workLogExtractor';
import type { Task } from '../db';
import type { ViewMode } from '../types';

interface UseGlobalVoiceProcessingArgs {
  audioBlob: Blob | null;
  viewMode: ViewMode;
  selectedModel: string;
  activeVoiceUpdateIdRef: MutableRefObject<number | null>;
  isProcessingRef: MutableRefObject<boolean>;
  setIsProcessing: (isProcessing: boolean) => void;
  setActiveVoiceUpdateId: (id: number | null) => void;
  setWorkLogExtracted: (batch: ExtractedWorkLogBatch | null) => void;
  clearAudio: () => void;
  addLog: (message: string, type?: 'info' | 'error') => void;
  applyAiResult: (result: Partial<Task>, updateId: number | null) => Promise<void>;
}

export function useGlobalVoiceProcessing({
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
}: UseGlobalVoiceProcessingArgs) {
  const handleProcessAudio = useCallback(async (blob: Blob) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setIsProcessing(true);

    const updateId = activeVoiceUpdateIdRef.current;

    if (viewMode === 'worklogs') {
      addLog(`Pracovní činnost — zpracovávám diktát…`, 'info');
      try {
        const result = await processWorkLogAudio(
          blob,
          (attempt, delay) => addLog(`AI Přetíženo - Pokus č.${attempt} (čekám ${delay / 1000}s)…`, 'info')
        );
        if (result.ok) {
          const totalHours = result.data.entries.reduce((sum, entry) => sum + entry.hours, 0);
          addLog(`AI extrahovalo: ${result.data.entries.length} návrhů (${totalHours.toFixed(2)}h)`, 'info');
          setWorkLogExtracted(result.data);
        } else {
          addLog(`AI extrakce selhala: ${result.error}`, 'error');
          alert(`AI extrakce selhala: ${result.error}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        addLog('WorkLog AI Chyba: ' + msg, 'error');
        alert(msg || 'Chyba při zpracování AI');
      } finally {
        isProcessingRef.current = false;
        setIsProcessing(false);
        activeVoiceUpdateIdRef.current = null;
        setActiveVoiceUpdateId(null);
        clearAudio();
      }
      return;
    }

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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog('AI Chyba: ' + msg, 'error');
      alert(msg || "Chyba při zpracování AI");
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
      activeVoiceUpdateIdRef.current = null;
      setActiveVoiceUpdateId(null);
      clearAudio();
    }
  }, [activeVoiceUpdateIdRef, addLog, applyAiResult, clearAudio, isProcessingRef, selectedModel, setActiveVoiceUpdateId, setIsProcessing, setWorkLogExtracted, viewMode]);

  useEffect(() => {
    if (audioBlob && !isProcessingRef.current) {
      handleProcessAudio(audioBlob);
    }
  }, [audioBlob, handleProcessAudio, isProcessingRef]);
}

