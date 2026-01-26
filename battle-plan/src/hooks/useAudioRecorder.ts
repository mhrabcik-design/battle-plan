import { useState, useRef, useCallback } from 'react';

export function useAudioRecorder() {
    const [isRecording, setIsRecording] = useState(false);
    const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
    const [mimeType, setMimeType] = useState<string>('audio/webm');
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const processorRef = useRef<ScriptProcessorNode | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);

    const startRecording = useCallback(async (onPcmData?: (base64: string) => void) => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;

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

            // Live PCM Processing if callback provided
            if (onPcmData) {
                const audioContext = new AudioContext({ sampleRate: 16000 });
                audioContextRef.current = audioContext;
                const source = audioContext.createMediaStreamSource(stream);

                // ScriptProcessor for 16-bit PCM conversion
                const processor = audioContext.createScriptProcessor(4096, 1, 1);
                processorRef.current = processor;

                processor.onaudioprocess = (e) => {
                    const inputData = e.inputBuffer.getChannelData(0);
                    // Convert Float32 to Int16
                    const pcmData = new Int16Array(inputData.length);
                    for (let i = 0; i < inputData.length; i++) {
                        pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
                    }
                    // Convert to Base64
                    const base64 = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
                    onPcmData(base64);
                };

                source.connect(processor);
                processor.connect(audioContext.destination);
            }

            setIsRecording(true);
        } catch (err) {
            console.error('Failed to start recording', err);
        }
    }, []);

    const stopRecording = useCallback(() => {
        if (isRecording) {
            mediaRecorderRef.current?.stop();

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

            setIsRecording(false);
        }
    }, [isRecording]);

    return {
        isRecording,
        startRecording,
        stopRecording,
        audioBlob,
        mimeType,
        clearAudio: () => setAudioBlob(null)
    };
}
