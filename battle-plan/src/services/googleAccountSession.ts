import { googleService } from './googleService.ts';

export function captureGoogleAccountSession() {
    const accountId = googleService.getAccountId();
    const generation = googleService.getAuthGeneration();
    const isCurrent = () => googleService.getAccountId() === accountId
        && googleService.getAuthGeneration() === generation;
    const assertCurrent = () => {
        if (!isCurrent()) throw new Error('Přihlášení Google se během synchronizace změnilo. Spusťte synchronizaci znovu.');
    };
    return { isCurrent, assertCurrent };
}

export type GoogleAccountSession = ReturnType<typeof captureGoogleAccountSession>;
