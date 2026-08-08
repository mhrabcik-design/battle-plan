/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppContext } from './appContext.ts';
import { renderAppContextSection } from './appContext.ts';

test('agent app context exposes absorbed aliases beside the canonical project id', () => {
    const context: AppContext = {
        activeProjects: [{
            id: 7,
            name: 'Komerční Banka',
            aliases: ['Komerční banka Plaza'],
            color: 'amber',
        }],
        archivedProjects: [],
        todaysWorklogs: [],
        config: { model: 'model', uiScale: 16, locale: 'cs-CZ' },
    };

    const rendered = renderAppContextSection(context);

    assert.match(rendered, /Komerční Banka \(id=7, barva=amber, aliasy=Komerční banka Plaza\)/);
});
