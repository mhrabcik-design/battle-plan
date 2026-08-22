/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';

import { describeSuggestionPartialSync } from './suggestionSyncDiagnostics.ts';

test('successful registry identifies each failed legacy mirror while confirming primary safety', () => {
    assert.equal(
        describeSuggestionPartialSync(
            'task byl vytvořen',
            { kind: 'published', decisionCount: 1 },
            { replyMirror: false, producerStatusMirror: false, primaryArtifact: 'decision-and-task' },
        ),
        'Suggestions: task byl vytvořen — primární rozhodnutí je bezpečně uložené a vytvořený task zůstal bezpečně v BattlePlanu; selhala legacy zrcadla: odpověď pro Anu, stav v souboru producenta.',
    );
    assert.equal(
        describeSuggestionPartialSync(
            'smazání bylo zaznamenáno',
            { kind: 'published', decisionCount: 1 },
            { deletionMirror: { suggestions: true, replies: false } },
        ),
        'Suggestions: smazání bylo zaznamenáno — primární rozhodnutí je bezpečně uložené; selhalo legacy zrcadlo: odpovědi pro Anu.',
    );
    assert.equal(
        describeSuggestionPartialSync(
            'zamítnutí bylo zaznamenáno',
            { kind: 'nothing-pending' },
            { replyMirror: false, producerStatusMirror: true },
        ),
        'Suggestions: zamítnutí bylo zaznamenáno — primární rozhodnutí je bezpečně uložené; selhalo legacy zrcadlo: odpověď pro Anu.',
    );
});

test('registry failures stay distinct from optional legacy mirror outcomes', () => {
    assert.equal(
        describeSuggestionPartialSync(
            'komentář byl zaznamenán',
            { kind: 'error', message: 'registry write failed' },
            { replyMirror: true },
        ),
        'Suggestions: komentář byl zaznamenán — primární rozhodnutí je bezpečně uložené v tomto zařízení, ale registr čeká na synchronizaci (registry write failed); legacy zrcadlo bylo aktualizováno.',
    );
    assert.equal(
        describeSuggestionPartialSync(
            'zamítnutí bylo zaznamenáno',
            { kind: 'store-unavailable', status: { code: 'auth-unavailable', message: 'Drive auth missing' } },
            { replyMirror: false, producerStatusMirror: true },
        ),
        'Suggestions: zamítnutí bylo zaznamenáno — primární rozhodnutí je bezpečně uložené v tomto zařízení, ale registr čeká na synchronizaci (Drive auth missing); selhalo legacy zrcadlo: odpověď pro Anu.',
    );
});

test('fully successful or mirror-free publication produces no error log', () => {
    assert.equal(
        describeSuggestionPartialSync(
            'smazání bylo zaznamenáno',
            { kind: 'published', decisionCount: 1 },
            { deletionMirror: { suggestions: true, replies: true } },
        ),
        null,
    );
    assert.equal(
        describeSuggestionPartialSync(
            'zamítnutí bylo zaznamenáno',
            { kind: 'published', decisionCount: 1 },
            { replyMirror: true, producerStatusMirror: true },
        ),
        null,
    );
    assert.equal(
        describeSuggestionPartialSync(
            'sloučení návrhů bylo zaznamenáno',
            { kind: 'nothing-pending' },
            {},
        ),
        null,
    );
});
