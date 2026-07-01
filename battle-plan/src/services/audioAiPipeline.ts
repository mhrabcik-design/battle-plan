const FETCH_TIMEOUT = 30000;

const GEMINI_INLINE_AUDIO_MIME_TYPES = new Set([
    'audio/wav',
    'audio/mp3',
    'audio/mpeg',
    'audio/aiff',
    'audio/aac',
    'audio/ogg',
    'audio/flac',
]);

type WindowWithWebkitAudio = typeof window & {
    webkitAudioContext?: typeof AudioContext;
};

export interface PreparedGeminiAudio {
    blob: Blob;
    base64Data: string;
    mimeType: string;
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

export function isRetryableFetchError(error: unknown): boolean {
    return isAbortError(error)
        || error instanceof TypeError
        || (error instanceof Error && error.message.includes('Failed to fetch'));
}

export function getRetryDelay(attempt: number): number {
    return Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 10000);
}

export function fetchWithTimeout(url: string, options: RequestInit, timeout: number = FETCH_TIMEOUT): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

export function normalizeMimeType(mimeType: string | undefined): string {
    return mimeType?.split(';')[0]?.trim().toLowerCase() || '';
}

function writeAscii(view: DataView, offset: number, value: string) {
    for (let i = 0; i < value.length; i++) {
        view.setUint8(offset + i, value.charCodeAt(i));
    }
}

function audioBufferToWavBlob(audioBuffer: AudioBuffer): Blob {
    const sampleRate = audioBuffer.sampleRate;
    const sampleCount = audioBuffer.length;
    const bytesPerSample = 2;
    const channelCount = 1;
    const dataSize = sampleCount * channelCount * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channelCount, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
    view.setUint16(32, channelCount * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, i) => audioBuffer.getChannelData(i));
    let offset = 44;
    for (let i = 0; i < sampleCount; i++) {
        const mixedSample = channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length;
        const sample = Math.max(-1, Math.min(1, mixedSample));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += bytesPerSample;
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

async function convertToWav(blob: Blob): Promise<Blob> {
    const AudioContextCtor = window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext;
    if (!AudioContextCtor) throw new Error('Prohlížeč neumí dekódovat audio pro převod do WAV.');

    const audioContext = new AudioContextCtor();
    try {
        const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
        return audioBufferToWavBlob(decoded);
    } finally {
        await audioContext.close();
    }
}

export async function normalizeAudioForGemini(blob: Blob): Promise<Blob> {
    const mimeType = normalizeMimeType(blob.type);
    if (mimeType && GEMINI_INLINE_AUDIO_MIME_TYPES.has(mimeType) && !blob.type.includes('codecs=')) {
        return blob;
    }

    try {
        return await convertToWav(blob);
    } catch (e) {
        console.error('Audio normalization failed', e);
        throw new Error(`Nahrávku se nepodařilo převést do formátu WAV. Původní typ: ${blob.type || 'neznámý'}.`);
    }
}

export async function blobToBase64Data(blob: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

export async function prepareGeminiAudio(blob: Blob): Promise<PreparedGeminiAudio> {
    const normalizedBlob = await normalizeAudioForGemini(blob);
    return {
        blob: normalizedBlob,
        base64Data: await blobToBase64Data(normalizedBlob),
        mimeType: normalizeMimeType(normalizedBlob.type) || 'audio/wav',
    };
}
