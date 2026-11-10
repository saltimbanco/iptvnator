import {
    buildStalkerIdentityRequestContext,
    buildStalkerRequestUrl,
    type ResolvedPortalPlayback,
    type StalkerScheduleRefresh,
} from '@iptvnator/shared/interfaces';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../database/connection';
import * as schema from '../database/schema';
import { assertRemoteUrlAllowed } from '../events/url-safety';
import { requestWithValidatedRedirects } from '../util/validated-axios';
import { buildStalkerPlaybackHeaders } from './stalker-playback-context.service';

export interface StalkerSchedulePortal {
    portalUrl: string;
    macAddress: string;
}

export interface StalkerSchedulePortalResponse {
    js?: {
        token?: unknown;
        cmd?: unknown;
        error?: unknown;
    };
}

/** One portal call; swappable so the flow is testable without a portal. */
export type StalkerScheduleTransport = (request: {
    portal: StalkerSchedulePortal;
    params: Record<string, string>;
    token?: string;
}) => Promise<StalkerSchedulePortalResponse>;

const HANDSHAKE_TIMEOUT_MS = 15_000;
const CREATE_LINK_TIMEOUT_MS = 30_000;

/**
 * Default transport: the same identity, URL builder and redirect validation
 * the STALKER_REQUEST handler uses, without its connectivity guard — a
 * scheduled start has one attempt and falls back to the stored link, so a
 * failing portal must not block later schedules on the same host.
 */
export const requestStalkerSchedulePortal: StalkerScheduleTransport = async ({
    portal,
    params,
    token,
}) => {
    await assertRemoteUrlAllowed(portal.portalUrl, {
        allowPrivateNetworks: true,
    });
    const { requestParams, headers } = buildStalkerIdentityRequestContext({
        macAddress: portal.macAddress,
        params,
        token,
    });
    const url = buildStalkerRequestUrl(portal.portalUrl, requestParams);
    const timeout =
        params.action === 'create_link'
            ? CREATE_LINK_TIMEOUT_MS
            : HANDSHAKE_TIMEOUT_MS;

    const response =
        await requestWithValidatedRedirects<StalkerSchedulePortalResponse>(
            url,
            {
                method: 'GET',
                headers,
                timeout,
                validateStatus: (status) => status < 500,
            },
            { allowPrivateNetworks: true }
        );

    return response.status >= 400 ? {} : (response.data ?? {});
};

/** The portal identity of a playlist row, or null once it is gone. */
export async function loadStalkerSchedulePortal(
    playlistId: string
): Promise<StalkerSchedulePortal | null> {
    try {
        const db = await getDatabase();
        const rows = await db
            .select({
                portalUrl: schema.playlists.portalUrl,
                url: schema.playlists.url,
                macAddress: schema.playlists.macAddress,
            })
            .from(schema.playlists)
            .where(eq(schema.playlists.id, playlistId))
            .limit(1);
        const playlist = rows[0];
        const portalUrl = playlist?.portalUrl ?? playlist?.url ?? '';
        if (!portalUrl || !playlist?.macAddress) {
            return null;
        }
        return { portalUrl, macAddress: playlist.macAddress };
    } catch (error) {
        console.error('[Recording schedule] playlist lookup failed:', error);
        return null;
    }
}

/**
 * A re-mint bound to one recording, as the recorder holds it: every
 * reconnect of a Stalker recording asks for a fresh link, because the one
 * the stream dropped on was minted for the session that had just died.
 * Resolves `null` when the portal cannot mint one; the caller then falls
 * back to the stored link.
 */
export function stalkerPlaybackRefresher(input: {
    refresh: StalkerScheduleRefresh;
    playlistId?: string | null;
    title?: string;
    thumbnail?: string | null;
}): () => Promise<ResolvedPortalPlayback | null> {
    return () =>
        refreshStalkerSchedulePlayback(input, {
            getPortal: loadStalkerSchedulePortal,
        });
}

/**
 * Re-mints a Stalker schedule's playback at the start instant.
 *
 * The renderer stores a `create_link` URL when the schedule is created, and
 * portals routinely expire those long before the recording starts (the
 * expiry is what makes the plain "store the URL" approach useless). The
 * portal identity lives on the playlist row, so the main process can
 * handshake and mint a fresh link itself — no window required.
 *
 * Resolves `null` for every failure (missing playlist, refused handshake,
 * portal error, unreachable host) so the scheduler can fall back to the
 * stored link instead of failing the row.
 */
export async function refreshStalkerSchedulePlayback(
    input: {
        refresh: StalkerScheduleRefresh;
        playlistId?: string | null;
        title?: string;
        thumbnail?: string | null;
    },
    deps: {
        getPortal: (
            playlistId: string
        ) => Promise<StalkerSchedulePortal | null>;
        transport?: StalkerScheduleTransport;
    }
): Promise<ResolvedPortalPlayback | null> {
    const playlistId = input.playlistId;
    const cmd = input.refresh?.cmd?.trim();
    if (input.refresh?.kind !== 'stalker' || !playlistId || !cmd) {
        return null;
    }

    const portal = await deps.getPortal(playlistId);
    if (!portal?.portalUrl || !portal.macAddress) {
        return null;
    }

    const transport = deps.transport ?? requestStalkerSchedulePortal;

    try {
        const handshake = await transport({
            portal,
            params: {
                type: 'stb',
                action: 'handshake',
                JsHttpRequest: '1-xml',
            },
        });
        const token =
            typeof handshake.js?.token === 'string'
                ? handshake.js.token.trim()
                : '';
        if (!token) {
            return null;
        }

        const link = await transport({
            portal,
            token,
            params: {
                type: input.refresh.contentType,
                action: 'create_link',
                cmd,
                disable_ad: '0',
                download: '0',
                JsHttpRequest: '1-xml',
            },
        });
        if (link.js?.error) {
            return null;
        }

        const streamUrl = resolveStreamUrl(portal.portalUrl, link.js?.cmd);
        if (!streamUrl) {
            return null;
        }

        const headers = buildStalkerPlaybackHeaders({
            streamUrl,
            portalUrl: portal.portalUrl,
            macAddress: portal.macAddress,
            token,
        });

        return {
            streamUrl,
            title: input.title ?? '',
            thumbnail: input.thumbnail ?? null,
            isLive: true,
            headers,
            userAgent: headers['User-Agent'],
            referer: headers['Referer'],
            origin: headers['Origin'],
        };
    } catch (error) {
        console.warn(
            '[Recording schedule] Stalker link refresh failed:',
            error instanceof Error ? error.message : String(error)
        );
        return null;
    }
}

/**
 * `create_link` answers carry the URL either bare or behind a `ffrt4 `
 * / `ffrt3 ` marker, and some portals answer with a portal-relative path.
 */
function resolveStreamUrl(portalUrl: string, raw: unknown): string | null {
    if (typeof raw !== 'string') {
        return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }
    const spaceIndex = trimmed.indexOf(' ');
    const candidate = (
        spaceIndex > 0 ? trimmed.slice(spaceIndex + 1) : trimmed
    ).trim();
    if (!candidate) {
        return null;
    }
    if (/^https?:\/\//i.test(candidate)) {
        return candidate;
    }
    try {
        return new URL(candidate, portalUrl).toString();
    } catch {
        return null;
    }
}
