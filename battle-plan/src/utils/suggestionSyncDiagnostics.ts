import type { SuggestionRegistryPublishResult } from '../services/suggestionRegistrySync.ts';

export interface SuggestionLegacyMirrors {
    replyMirror?: boolean;
    producerStatusMirror?: boolean;
    deletionMirror?: {
        suggestions: boolean;
        replies?: boolean;
    };
    primaryArtifact?: 'decision' | 'decision-and-task';
}

type RegistryPublishSuccess = Extract<
    SuggestionRegistryPublishResult,
    { kind: 'published' } | { kind: 'nothing-pending' }
>;

const registryWriteSucceeded = (
    result: SuggestionRegistryPublishResult,
): result is RegistryPublishSuccess =>
    result.kind === 'published' || result.kind === 'nothing-pending';

const registryFailureMessage = (
    result: Exclude<SuggestionRegistryPublishResult, RegistryPublishSuccess>,
): string => {
    if (result.kind === 'error') return result.message;
    return result.status?.message ?? 'registr rozhodnutí není na Drive dostupný';
};

export function describeSuggestionPartialSync(
    action: string,
    registryResult: SuggestionRegistryPublishResult,
    mirrors: SuggestionLegacyMirrors,
): string | null {
    const applicableMirrors = [
        mirrors.replyMirror === undefined
            ? null
            : { label: 'odpověď pro Anu', succeeded: mirrors.replyMirror },
        mirrors.producerStatusMirror === undefined
            ? null
            : { label: 'stav v souboru producenta', succeeded: mirrors.producerStatusMirror },
        mirrors.deletionMirror === undefined
            ? null
            : { label: 'návrh v souboru producenta', succeeded: mirrors.deletionMirror.suggestions },
        mirrors.deletionMirror?.replies === undefined
            ? null
            : { label: 'odpovědi pro Anu', succeeded: mirrors.deletionMirror.replies },
    ].filter((mirror): mirror is { label: string; succeeded: boolean } => mirror !== null);
    const failedMirrors = applicableMirrors.filter((mirror) => !mirror.succeeded);
    const primarySafety = mirrors.primaryArtifact === 'decision-and-task'
        ? 'primární rozhodnutí je bezpečně uložené a vytvořený task zůstal bezpečně v BattlePlanu'
        : 'primární rozhodnutí je bezpečně uložené';
    const primaryLocalSafety = mirrors.primaryArtifact === 'decision-and-task'
        ? 'primární rozhodnutí i vytvořený task jsou bezpečně uložené v tomto zařízení'
        : 'primární rozhodnutí je bezpečně uložené v tomto zařízení';

    if (registryWriteSucceeded(registryResult)) {
        if (failedMirrors.length === 0) return null;
        const legacyLabel = failedMirrors.length === 1 ? 'selhalo legacy zrcadlo' : 'selhala legacy zrcadla';
        return `Suggestions: ${action} — ${primarySafety}; ${legacyLabel}: ${failedMirrors.map((mirror) => mirror.label).join(', ')}.`;
    }

    const registryDetail = `${primaryLocalSafety}, ale registr čeká na synchronizaci (${registryFailureMessage(registryResult)})`;
    if (failedMirrors.length > 0) {
        const legacyLabel = failedMirrors.length === 1 ? 'selhalo legacy zrcadlo' : 'selhala legacy zrcadla';
        return `Suggestions: ${action} — ${registryDetail}; ${legacyLabel}: ${failedMirrors.map((mirror) => mirror.label).join(', ')}.`;
    }
    if (applicableMirrors.length === 0) {
        return `Suggestions: ${action} — ${registryDetail}.`;
    }
    const legacySuccess = applicableMirrors.length === 1
        ? 'legacy zrcadlo bylo aktualizováno'
        : 'legacy zrcadla byla aktualizována';
    return `Suggestions: ${action} — ${registryDetail}; ${legacySuccess}.`;
}
