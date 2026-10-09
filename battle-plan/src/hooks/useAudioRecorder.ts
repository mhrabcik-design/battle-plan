import { useState, useRef, useCallback, useEffect } from 'react';

export interface RecorderOptions {
    onAccepted?: () => void;
    onSilence?: () => void;
    silenceThreshold?: number;
    silenceDuration?: number;
    enableFeedback?: boolean;
}

const PREFERRED_RECORDING_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
type WindowWithWebkitAudio = typeof window & { webkitAudioContext?: typeof AudioContext };
type RecorderSession = {
    phase: 'acquiring' | 'recording' | 'stopping' | 'completed' | 'cancelled';
    pending: boolean;
    options: RecorderOptions;
    stream: MediaStream | null;
    recorder: MediaRecorder | null;
    context: AudioContext | null;
    source: MediaStreamAudioSourceNode | null;
    analyser: AnalyserNode | null;
    silenceTimer: ReturnType<typeof setTimeout> | null;
    frame: number | null;
    chunks: Blob[];
    startedAt: number;
};
type Feedback = {
    context: AudioContext;
    oscillator: OscillatorNode | null;
    gain: GainNode | null;
    timer: ReturnType<typeof setTimeout> | null;
};

function release(action: () => void | Promise<void>) {
    try {
        const pending = action();
        if (pending) void pending.catch(error => console.warn('Audio cleanup failed', error));
    } catch (error) {
        console.warn('Audio cleanup failed', error);
    }
}

function releaseSession(session: RecorderSession, keepStopHandlers = false) {
    if (session.silenceTimer !== null) clearTimeout(session.silenceTimer);
    if (session.frame !== null) cancelAnimationFrame(session.frame);
    session.silenceTimer = null;
    session.frame = null;
    if (!keepStopHandlers && session.recorder) {
        const recorder = session.recorder;
        session.recorder = null;
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== 'inactive') release(() => recorder.stop());
    }
    if (session.source) release(() => session.source!.disconnect());
    if (session.analyser) release(() => session.analyser!.disconnect());
    if (session.context) release(() => session.context!.close());
    if (session.stream) session.stream.getTracks().forEach(track => release(() => track.stop()));
    session.source = null;
    session.analyser = null;
    session.context = null;
    session.stream = null;
    if (!keepStopHandlers) session.chunks = [];
}

function releaseFeedback(feedback: Feedback) {
    if (feedback.timer !== null) clearTimeout(feedback.timer);
    feedback.timer = null;
    if (feedback.oscillator) {
        feedback.oscillator.onended = null;
        release(() => feedback.oscillator!.stop());
        release(() => feedback.oscillator!.disconnect());
    }
    if (feedback.gain) release(() => feedback.gain!.disconnect());
    release(() => feedback.context.close());
}

export function useAudioRecorder() {
    const [isRecording, setIsRecording] = useState(false);
    const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
    const [mimeType, setMimeType] = useState('audio/webm');
    const [duration, setDuration] = useState(0);
    const sessionRef = useRef<RecorderSession | null>(null);
    const feedbackRef = useRef<Feedback | null>(null);
    const mountedRef = useRef(true);

    const clearFeedback = useCallback(() => {
        if (feedbackRef.current) releaseFeedback(feedbackRef.current);
        feedbackRef.current = null;
    }, []);

    const playFeedback = useCallback((type: 'start' | 'stop', options: RecorderOptions) => {
        clearFeedback();
        if (!options.enableFeedback) return;
        if ('vibrate' in navigator) navigator.vibrate(type === 'start' ? 50 : [30, 30, 30]);
        try {
            const Constructor = window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext;
            if (!Constructor) return;
            const feedback: Feedback = { context: new Constructor(), oscillator: null, gain: null, timer: null };
            feedbackRef.current = feedback;
            const oscillator = feedback.context.createOscillator();
            feedback.oscillator = oscillator;
            const gain = feedback.context.createGain();
            feedback.gain = gain;
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(type === 'start' ? 880 : 440, feedback.context.currentTime);
            gain.gain.setValueAtTime(0.1, feedback.context.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, feedback.context.currentTime + 0.2);
            oscillator.connect(gain);
            gain.connect(feedback.context.destination);
            oscillator.start();
            oscillator.stop(feedback.context.currentTime + 0.2);
            // The short stop tone owns its context until it ends; unmount cancels it immediately.
            feedback.timer = setTimeout(() => {
                if (feedbackRef.current === feedback) clearFeedback();
            }, 300);
        } catch (error) {
            clearFeedback();
            console.warn('Audio feedback failed', error);
        }
    }, [clearFeedback]);

    const cancelRecording = useCallback(() => {
        const session = sessionRef.current;
        if (session) {
            session.phase = 'cancelled';
            releaseSession(session);
            // getUserMedia cannot be aborted. Keep its reservation until the late result is released.
            if (!session.pending) sessionRef.current = null;
        }
        clearFeedback();
        if (mountedRef.current) setIsRecording(false);
    }, [clearFeedback]);

    const startRecording = useCallback(async (options: RecorderOptions = {}): Promise<boolean> => {
        if (!mountedRef.current || sessionRef.current) return false;
        const session: RecorderSession = {
            phase: 'acquiring', pending: true, options, stream: null, recorder: null, context: null,
            source: null, analyser: null, silenceTimer: null, frame: null, chunks: [], startedAt: 0,
        };
        sessionRef.current = session;
        const isCurrent = () => mountedRef.current && sessionRef.current === session && session.phase !== 'cancelled';
        try {
            // Ownership is committed only after the synchronous reservation succeeds.
            options.onAccepted?.();
            session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            session.pending = false;
            if (!isCurrent()) {
                releaseSession(session);
                if (sessionRef.current === session) sessionRef.current = null;
                return false;
            }
            const supportedType = PREFERRED_RECORDING_MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type));
            const recorder = supportedType ? new MediaRecorder(session.stream, { mimeType: supportedType }) : new MediaRecorder(session.stream);
            session.recorder = recorder;
            recorder.ondataavailable = event => {
                if (isCurrent() && (session.phase === 'recording' || session.phase === 'stopping') && event.data.size > 0) {
                    session.chunks.push(event.data);
                }
            };
            recorder.onstop = () => {
                if (!isCurrent() || (session.phase !== 'recording' && session.phase !== 'stopping')) return;
                const stoppedByBrowser = session.phase === 'recording';
                const blob = new Blob(session.chunks, { type: recorder.mimeType });
                session.phase = 'completed';
                releaseSession(session);
                setIsRecording(false);
                setDuration((Date.now() - session.startedAt) / 1000);
                setAudioBlob(blob);
                if (stoppedByBrowser) playFeedback('stop', session.options);
            };
            recorder.onerror = () => {
                if (isCurrent()) cancelRecording();
            };
            let checkSilence: (() => void) | undefined;
            if (options.onSilence) {
                session.context = new AudioContext();
                session.source = session.context.createMediaStreamSource(session.stream);
                session.analyser = session.context.createAnalyser();
                session.analyser.fftSize = 256;
                session.source.connect(session.analyser);
                const analyser = session.analyser;
                const samples = new Float32Array(analyser.frequencyBinCount);
                const sampleSilence = () => {
                    session.frame = null;
                    if (!isCurrent() || session.phase !== 'recording') return;
                    analyser.getFloatTimeDomainData(samples);
                    let sum = 0;
                    for (const amplitude of samples) sum += amplitude * amplitude;
                    const rms = Math.sqrt(sum / samples.length);
                    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
                    if (db < (options.silenceThreshold ?? -50)) {
                        if (session.silenceTimer === null) {
                            session.silenceTimer = setTimeout(() => {
                                session.silenceTimer = null;
                                if (isCurrent() && session.phase === 'recording') options.onSilence?.();
                            }, options.silenceDuration ?? 3000);
                        }
                    } else if (session.silenceTimer !== null) {
                        clearTimeout(session.silenceTimer);
                        session.silenceTimer = null;
                    }
                    if (isCurrent() && session.phase === 'recording') session.frame = requestAnimationFrame(sampleSilence);
                };
                checkSilence = sampleSilence;
            }
            recorder.start();
            session.startedAt = Date.now();
            session.phase = 'recording';
            setMimeType(recorder.mimeType);
            setIsRecording(true);
            playFeedback('start', options);
            checkSilence?.();
            return true;
        } catch (error) {
            session.pending = false;
            const current = isCurrent();
            session.phase = 'cancelled';
            releaseSession(session);
            if (sessionRef.current === session) sessionRef.current = null;
            if (!current) return false;
            clearFeedback();
            setIsRecording(false);
            console.error('Failed to start recording', error);
            throw error;
        }
    }, [cancelRecording, clearFeedback, playFeedback]);

    const stopRecording = useCallback(() => {
        const session = sessionRef.current;
        if (!session) return;
        if (session.phase === 'acquiring') { cancelRecording(); return; }
        if (session.phase !== 'recording') return;
        session.phase = 'stopping';
        try {
            session.recorder!.stop();
        } catch (error) {
            cancelRecording();
            console.error('Failed to stop recording', error);
            return;
        }
        releaseSession(session, true);
        setDuration((Date.now() - session.startedAt) / 1000);
        setIsRecording(false);
        playFeedback('stop', session.options);
        // Retain ownership through onstop and processing; clearAudio consumes the completed session.
    }, [cancelRecording, playFeedback]);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            cancelRecording();
        };
    }, [cancelRecording]);

    const clearAudio = useCallback(() => {
        cancelRecording();
        if (!mountedRef.current) return;
        setAudioBlob(null);
        setDuration(0);
    }, [cancelRecording]);

    const hasRecordingSession = useCallback(() => sessionRef.current !== null, []);

    return { isRecording, startRecording, stopRecording, cancelRecording, hasRecordingSession, audioBlob, mimeType, duration, clearAudio };
}
