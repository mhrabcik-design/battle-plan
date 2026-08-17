export function createRegistryErrorLogGate() {
    let previous: string | null = null;
    return {
        shouldLog(message: string): boolean {
            if (message === previous) return false;
            previous = message;
            return true;
        },
        recovered(): void {
            previous = null;
        },
    };
}
