import { useState, useRef, useCallback } from 'react';

export interface RecorderOptions {
    onSilence?: () => void;
    silenceThreshold?: number;
    silenceDuration?: number;
    enableFeedback?: boolean;
}

const PREFERRED_RECORDING_MIME_TYPES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
];

type WindowWithWebkitAudio = typeof window & {
    webkitAudioContext?: typeof AudioContext;
};

function getSupportedRecordingMimeType(): string | undefined {
    if (!('MediaRecorder' in window)) return undefined;
    return PREFERRED_RECORDING_MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type));
}

export function useAudioRecorder() {
    const [isRecording, setIsRecording] = useState(false);
    const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
    const [mimeType, setMimeType] = useState<string>('audio/webm');
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const startTimeRef = useRef<number>(0);
    const [duration, setDuration] = useState(0);
    const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const optionsRef = useRef<RecorderOptions>({});
    const isRecordingRef = useRef(false);

    const playFeedback = (type: 'start' | 'stop') => {
        if (!optionsRef.current.enableFeedback) return;

        if ('vibrate' in navigator) {
            navigator.vibrate(type === 'start' ? 50 : [30, 30, 30]);
        }

        try {
            const AudioContextCtor = window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext;
            if (!AudioContextCtor) return;

            const ctx = new AudioContextCtor();
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
            osc.onended = () => { osc.disconnect(); gain.disconnect(); };
            setTimeout(() => ctx.close(), 300);
        } catch (err) {
            console.warn('Audio feedback failed', err);
        }
    };

    const startRecording = useCallback(async (options: RecorderOptions = {}) => {
        try {
            optionsRef.current = options;
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            startTimeRef.current = Date.now();
            playFeedback('start');

            const supportedMimeType = getSupportedRecordingMimeType();
            const mediaRecorder = supportedMimeType
                ? new MediaRecorder(stream, { mimeType: supportedMimeType })
                : new MediaRecorder(stream);
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

            const audioContext = new AudioContext();
            audioContextRef.current = audioContext;
            const source = audioContext.createMediaStreamSource(stream);

            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Float32Array(bufferLength);

            const threshold = options.silenceThreshold || -50;
            const silDuration = options.silenceDuration || 3000;

            const checkSilence = () => {
                if (!isRecordingRef.current || !streamRef.current) return;

                analyser.getFloatTimeDomainData(dataArray);
                let sumSquares = 0.0;
                for (const amplitude of dataArray) {
                    sumSquares += amplitude * amplitude;
                }
                const rms = Math.sqrt(sumSquares / dataArray.length);
                const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

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

            isRecordingRef.current = true;
            setIsRecording(true);
            checkSilence();
        } catch (err) {
            console.error('Failed to start recording', err);
        }
    }, []);

    const stopRecording = useCallback(() => {
        if (!isRecordingRef.current) return;

        isRecordingRef.current = false;
        playFeedback('stop');
        if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.stop();
        }

        if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
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
    }, []);

    return {
        isRecording,
        startRecording,
        stopRecording,
        audioBlob,
        mimeType,
        duration,
        clearAudio: useCallback(() => { setAudioBlob(null); setDuration(0); }, [])
    };
}
