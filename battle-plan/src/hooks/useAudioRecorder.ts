import { useState, useRef, useCallback } from 'react';

export interface RecorderOptions {
    onSilence?: () => void;
    silenceThreshold?: number; // dB, default -50
    silenceDuration?: number; // ms, default 3000
    enableFeedback?: boolean;
}

export function useAudioRecorder() {
    const [isRecording, setIsRecording] = useState(false);
    const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
    const [mimeType, setMimeType] = useState<string>('audio/webm');
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const processorRef = useRef<ScriptProcessorNode | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const startTimeRef = useRef<number>(0);
    const [duration, setDuration] = useState(0);
    const silenceTimerRef = useRef<any>(null);
    const optionsRef = useRef<RecorderOptions>({});

    const playFeedback = (type: 'start' | 'stop') => {
        if (!optionsRef.current.enableFeedback) return;

        // Haptic feedback
        if ('vibrate' in navigator) {
            navigator.vibrate(type === 'start' ? 50 : [30, 30, 30]);
        }

        // Audio feedback
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(type === 'start' ? 880 : 440, ctx.currentTime);

        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start();
        osc.stop(ctx.currentTime + 0.2);
        setTimeout(() => ctx.close(), 300);
    };

    const startRecording = useCallback(async (options: RecorderOptions = {}) => {
        try {
            optionsRef.current = options;
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            startTimeRef.current = Date.now();
            playFeedback('start');

            // Standard MediaRecorder for the final blob
            const mediaRecorder = new MediaRecorder(stream);
            mediaRecorderRef.current = mediaRecorder;
            setMimeType(mediaRecorder.mimeType);
            chunksRef.current = [];

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    chunksRef.current.push(e.data);
                }
            };

            mediaRecorder.onstop = () => {
                const fullBlob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType });
                setAudioBlob(fullBlob);
            };

            mediaRecorder.start();

            // Setup AudioContext for Silence Detection
            const audioContext = new AudioContext();
            audioContextRef.current = audioContext;
            const source = audioContext.createMediaStreamSource(stream);

            // Silence Detection
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Float32Array(bufferLength);

            const threshold = options.silenceThreshold || -50;
            const silDuration = options.silenceDuration || 3000;

            const checkSilence = () => {
                if (!isRecording && !streamRef.current) return;

                analyser.getFloatTimeDomainData(dataArray);
                let sumSquares = 0.0;
                for (const amplitude of dataArray) {
                    sumSquares += amplitude * amplitude;
                }
                const rms = Math.sqrt(sumSquares / dataArray.length);
                const db = 20 * Math.log10(rms);

                if (db < threshold) {
                    if (!silenceTimerRef.current) {
                        silenceTimerRef.current = setTimeout(() => {
                            if (options.onSilence) options.onSilence();
                        }, silDuration);
                    }
                } else {
                    if (silenceTimerRef.current) {
                        clearTimeout(silenceTimerRef.current);
                        silenceTimerRef.current = null;
                    }
                }

                if (streamRef.current) {
                    requestAnimationFrame(checkSilence);
                }
            };

            checkSilence();

            setIsRecording(true);
        } catch (err) {
            console.error('Failed to start recording', err);
        }
    }, []);

    const stopRecording = useCallback(() => {
        if (isRecording) {
            playFeedback('stop');
            mediaRecorderRef.current?.stop();

            if (silenceTimerRef.current) {
                clearTimeout(silenceTimerRef.current);
                silenceTimerRef.current = null;
            }

            if (processorRef.current) {
                processorRef.current.disconnect();
                processorRef.current = null;
            }
            if (audioContextRef.current) {
                audioContextRef.current.close();
                audioContextRef.current = null;
            }
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
                streamRef.current = null;
            }

            const finalDuration = (Date.now() - startTimeRef.current) / 1000;
            setDuration(finalDuration);
            setIsRecording(false);
        }
    }, [isRecording]);

    return {
        isRecording,
        startRecording,
        stopRecording,
        audioBlob,
        mimeType,
        duration,
        clearAudio: () => { setAudioBlob(null); setDuration(0); }
    };
}
