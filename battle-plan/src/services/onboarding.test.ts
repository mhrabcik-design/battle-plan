/// <reference types="node" />
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

const { db } = await import('../db.ts');
const {
    AGENT_ONBOARDING_DISMISSED_AT,
    AGENT_ONBOARDING_TTL_MS,
    dismissOnboarding,
    isOnboardingDismissed,
    resetOnboarding,
} = await import('./onboarding.ts');

beforeEach(async () => {
    await db.delete();
    await db.open();
});

test('fresh user has no onboarding dismissal', async () => {
    assert.equal(await isOnboardingDismissed(1_000), false);
});

test('dismissOnboarding persists a current dismissal timestamp', async () => {
    const now = 2_000;
    await dismissOnboarding(now);

    assert.equal(await isOnboardingDismissed(now), true);
    assert.equal((await db.settings.get(AGENT_ONBOARDING_DISMISSED_AT))?.value, String(now));
});

test('dismissal older than 90 days expires', async () => {
    const dismissedAt = 5_000;
    await dismissOnboarding(dismissedAt);

    assert.equal(await isOnboardingDismissed(dismissedAt + AGENT_ONBOARDING_TTL_MS + 1), false);
});

test('resetOnboarding clears the dismissal', async () => {
    await dismissOnboarding(3_000);
    await resetOnboarding();

    assert.equal(await isOnboardingDismissed(3_001), false);
});
