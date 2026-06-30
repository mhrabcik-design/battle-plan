declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
declare const __BUILD_COMMIT__: string;

export type DeploymentChannel = 'local-dev' | 'github-pages' | 'desktop-app' | 'custom-origin';

export interface BuildInfo {
    version: string;
    buildTime: string;
    commit: string;
    origin: string;
    channel: DeploymentChannel;
    channelLabel: string;
    oauthOriginHint: string;
}

const getOrigin = (): string => {
    if (typeof window === 'undefined') return 'unknown';
    return window.location.origin;
};

const getChannel = (origin: string): DeploymentChannel => {
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return 'local-dev';
    if (origin === 'https://mhrabcik-design.github.io') return 'github-pages';
    if (origin.startsWith('app://') || origin.startsWith('tauri://')) return 'desktop-app';
    return 'custom-origin';
};

const getChannelLabel = (channel: DeploymentChannel): string => {
    if (channel === 'local-dev') return 'Lokální vývoj';
    if (channel === 'github-pages') return 'GitHub Pages';
    if (channel === 'desktop-app') return 'Desktop aplikace';
    return 'Vlastní origin';
};

const getOauthOriginHint = (channel: DeploymentChannel, origin: string): string => {
    if (channel === 'github-pages') return 'Produkční GitHub Pages origin';
    if (channel === 'local-dev') return `${origin} musí být povolený v Google OAuth JavaScript origins`;
    if (channel === 'desktop-app') return 'Desktop wrapper musí používat origin povolený pro Google OAuth';
    return 'Zkontroluj Google OAuth JavaScript origins pro tento origin';
};

export const getBuildInfo = (): BuildInfo => {
    const origin = getOrigin();
    const channel = getChannel(origin);

    return {
        version: __APP_VERSION__ || 'unknown',
        buildTime: __BUILD_TIME__ || 'unknown',
        commit: __BUILD_COMMIT__ || 'local',
        origin,
        channel,
        channelLabel: getChannelLabel(channel),
        oauthOriginHint: getOauthOriginHint(channel, origin),
    };
};

export const buildInfo = getBuildInfo();
