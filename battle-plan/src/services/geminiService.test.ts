import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { toLocalIsoDate } from '../utils/monthCalendar.ts';

process.env.TZ = 'Europe/Prague';
const localMidnight = new Date(2026, 9, 9, 0, 30).getTime();
class PromptDate extends Date {
    constructor(value?: string | number) { super(value === undefined ? localMidnight : value); }
}

function loadSource(file: string, dependencies: Record<string, unknown>): Record<string, unknown> {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^import[\s\S]*?;\r?\n/gm, '');
    const exports: Record<string, unknown> = {};
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, { exports, ...dependencies });
    return exports;
}

test('processAudio sends a prompt whose local date agrees with its weekday and clock at Prague 00:30', async () => {
    assert.equal(new PromptDate().toISOString().slice(0, 10), '2026-10-08', 'fixture crosses the UTC day boundary');
    // Execute the real prompt template and processAudio; only IO/audio conversion is stubbed.
    const { getSystemPrompt } = loadSource('./semanticEngine.ts', {});
    let requestBody = '';
    const audio = new Blob(['recording'], { type: 'audio/wav' });
    const { GeminiService } = loadSource('./geminiService.ts', {
        Date: PromptDate, toLocalIsoDate, getSystemPrompt, console: { log: () => {} },
        db: { settings: { get: async (key: string) => ({ value: key === 'gemini_api_key' ? 'fixture-key' : 'fixture-model' }) } },
        prepareGeminiAudio: async (blob: Blob) => {
            assert.equal(blob, audio);
            return { mimeType: 'audio/wav', base64Data: 'fixture-audio' };
        },
        buildAppContext: async () => undefined,
        fetchWithTimeout: async (_url: string, options: RequestInit) => {
            requestBody = String(options.body);
            return Response.json({ candidates: [{ content: { parts: [{ text: '{"title":"Today"}' }] } }] });
        },
    });
    const service = new (GeminiService as new () => { processAudio: (blob: Blob) => Promise<{ title: string }> })();
    assert.equal((await service.processAudio(audio)).title, 'Today');
    const prompt = JSON.parse(requestBody).contents[0].parts[0].text as string;
    assert.match(prompt, /Dnešní datum je: pátek 2026-10-09 \(čas: 00:30:00\)/);
    assert.match(prompt, /"Dnes" = 2026-10-09/);
});
