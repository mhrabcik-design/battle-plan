import assert from 'node:assert/strict';
import { test } from 'node:test';
import Dexie from 'dexie';
import { BattlePlanDB, type Task } from '../db.ts';
import { getSchedule, saveWeeklySchedule } from './weeklySchedule.ts';

test('undo restores move and resize fields, preserves later text edits and refuses newer schedules or deleted tasks', async () => {
    const database = new BattlePlanDB(`weekly-undo-${crypto.randomUUID()}`);
    try {
        const task: Task = { title: 'Task', type: 'task', urgency: 2, status: 'pending',
            date: '2026-09-10', deadline: '2026-09-10', createdAt: 1, updatedAt: 1 };
        const id = await database.tasks.add(task);
        const moved = await saveWeeklySchedule(database, id, { date: '2026-09-17', deadline: '2026-09-17', startTime: '15:00', isAllDay: false, duration: 90 });
        assert.ok(moved);
        await database.tasks.update(id, { title: 'Edited title' });
        const undone = await saveWeeklySchedule(database, id, getSchedule(moved.before), moved.after);
        assert.ok(undone);
        assert.deepEqual(getSchedule(undone.after), getSchedule(task));
        assert.equal(undone.after.title, 'Edited title');
        assert.equal((await database.tasks.get(id))?.duration, undefined);
        const resized = await saveWeeklySchedule(database, id, { duration: 120, startTime: '17:00' });
        assert.ok(resized);
        await database.tasks.update(id, { startTime: '18:00' });
        assert.equal(await saveWeeklySchedule(database, id, getSchedule(resized.before), resized.after), null);
        assert.equal((await database.tasks.get(id))?.startTime, '18:00');
        await database.tasks.update(id, { isDeleted: true });
        assert.equal(await saveWeeklySchedule(database, id, getSchedule(task)), null);
        await database.tasks.delete(id);
        assert.equal(await saveWeeklySchedule(database, id, getSchedule(task)), null);
    } finally {
        database.close();
        await Dexie.delete(database.name);
    }
});
