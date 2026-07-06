import { db } from '../db.ts';

export const AGENT_ONBOARDING_DISMISSED_AT = 'agent_onboarding_dismissed_at';
export const AGENT_ONBOARDING_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export async function isOnboardingDismissed(now: number = Date.now()): Promise<boolean> {
    try {
        const setting = await db.settings.get(AGENT_ONBOARDING_DISMISSED_AT);
        if (!setting?.value) return false;
        const dismissedAt = Number(setting.value);
        if (!Number.isFinite(dismissedAt)) return false;
        return now - dismissedAt <= AGENT_ONBOARDING_TTL_MS;
    } catch (error) {
        console.error('Onboarding dismissed-state read failed', error);
        return false;
    }
}

export async function dismissOnboarding(now: number = Date.now()): Promise<void> {
    try {
        await db.settings.put({
            id: AGENT_ONBOARDING_DISMISSED_AT,
            value: String(now),
            source: 'user',
        });
    } catch (error) {
        console.error('Onboarding dismiss write failed', error);
    }
}

export async function resetOnboarding(): Promise<void> {
    try {
        await db.settings.delete(AGENT_ONBOARDING_DISMISSED_AT);
    } catch (error) {
        console.error('Onboarding reset failed', error);
    }
}
