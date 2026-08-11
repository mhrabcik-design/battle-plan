import assert from 'node:assert/strict';
import test from 'node:test';
import { toggleWorkLogsPanel } from './workLogsPageUi.ts';

test('work-log action opens its panel and the same action closes it', () => {
    assert.equal(toggleWorkLogsPanel(null, 'projects'), 'projects');
    assert.equal(toggleWorkLogsPanel('projects', 'projects'), null);
});

test('opening another work-log panel replaces the currently open panel', () => {
    assert.equal(toggleWorkLogsPanel('new-entry', 'projects'), 'projects');
    assert.equal(toggleWorkLogsPanel('projects', 'new-entry'), 'new-entry');
});
