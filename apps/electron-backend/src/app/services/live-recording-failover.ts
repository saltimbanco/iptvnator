import { eq, sql } from 'drizzle-orm';
import { appendFile, readFile, stat, unlink } from 'node:fs/promises';
import {
    liveChannelSearchProbes,
    rankLiveChannelCandidates,
} from '@iptvnator/playback/util/live-channel-match';
import type { ResolvedPortalPlayback } from '@iptvnator/shared/interfaces';
import { getDatabase } from '../database/connection';
import * as schema from '../database/schema';
import { broadcastRecordingsUpdate } from '../events/database/recording-broadcast';

/** Rows the fuzzy channel search is allowed to look at. */
const CANDIDATE_LIMIT = 400;

interface LiveCatalogRow {
    title: string;
    xtream_id: number;
    direct_source: string | null;
    playlist_id: string;
    playlist_name: string;
    playlist_type: string;
    server_url: string | null;
    username: string | null;
    password: string | null;
    position: number | null;
    user_agent: string | null;
    origin: string | null;
    referrer: string | null;
}

/**
 * A live channel's stream URL in a playlist, in the shape the recorder needs.
 *
 * M3U channels carry their URL. Xtream rows store only the stream id, so the
 * URL is rebuilt from the playlist's own credentials — the same shape the
 * renderer sends when a recording is started from the channel list.
 */
function playbackForRow(row: LiveCatalogRow): ResolvedPortalPlayback | null {
    const headers: Record<string, string> = {};
    if (row.user_agent?.trim()) {
        headers['User-Agent'] = row.user_agent.trim();
    }
    if (row.referrer?.trim()) {
        headers['Referer'] = row.referrer.trim();
    }
    if (row.origin?.trim()) {
        headers['Origin'] = row.origin.trim();
    }

    if (row.playlist_type === 'xtream') {
        const server = row.server_url?.trim().replace(/\/+$/, '');
        if (!server || !row.username || !row.password || !row.xtream_id) {
            return null;
        }
        return {
            streamUrl: `${server}/live/${row.username}/${row.password}/${row.xtream_id}.ts`,
            title: row.title,
            isLive: true,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
        };
    }

    const streamUrl = row.direct_source?.trim();
    return streamUrl
        ? {
              streamUrl,
              title: row.title,
              isLive: true,
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
          }
        : null;
}

/**
 * The same live channel in the user's other playlists, in source order.
 *
 * The scheduled recorder runs in the main process, so it cannot ask the
 * renderer for its cross-source failover: this reads the same desktop
 * catalog (Xtream and M3U; Stalker channels have no catalog rows) and ranks
 * the hits with the shared fuzzy matcher. `failingPlaylistId` is excluded —
 * hopping back into the source that just failed is not a hop.
 */
export async function findLiveAlternatePlaybacks(
    channelName: string,
    failingPlaylistId?: string
): Promise<ResolvedPortalPlayback[]> {
    const name = channelName?.trim();
    if (!name) {
        return [];
    }

    let rows: LiveCatalogRow[] = [];
    try {
        const db = await getDatabase();
        for (const probe of liveChannelSearchProbes(name)) {
            rows = (await db.all(sql`
                SELECT
                    c.title AS title,
                    c.xtream_id AS xtream_id,
                    c.direct_source AS direct_source,
                    cat.playlist_id AS playlist_id,
                    p.name AS playlist_name,
                    p.type AS playlist_type,
                    p.serverUrl AS server_url,
                    p.username AS username,
                    p.password AS password,
                    p.position AS position,
                    p.userAgent AS user_agent,
                    p.origin AS origin,
                    p.referrer AS referrer
                FROM content AS c
                INNER JOIN categories AS cat ON c.category_id = cat.id
                INNER JOIN playlists AS p ON cat.playlist_id = p.id
                WHERE c.type = 'live'
                  AND (p.type = 'xtream' OR p.type LIKE 'm3u-%')
                  AND lower(c.title) LIKE ${`%${probe.toLowerCase()}%`}
                LIMIT ${CANDIDATE_LIMIT}
            `)) as LiveCatalogRow[];
            if (rows.length > 0) {
                break;
            }
        }
    } catch (error) {
        console.warn('[Background recording] alternate source search failed:', error);
        return [];
    }

    if (rows.length === 0) {
        return [];
    }

    const byPlaylist = new Map(rows.map((row) => [row.playlist_id, row]));
    const order = [...byPlaylist.values()]
        .sort(
            (left, right) =>
                (left.position ?? 0) - (right.position ?? 0) ||
                left.playlist_name.localeCompare(right.playlist_name)
        )
        .map((row) => row.playlist_id);

    const ranked = rankLiveChannelCandidates(
        name,
        rows.map((row) => ({
            playlistId: row.playlist_id,
            title: row.title,
            row,
        })),
        order,
        failingPlaylistId ?? null
    );

    const playbacks: ResolvedPortalPlayback[] = [];
    const seen = new Set<string>();
    for (const candidate of ranked) {
        const playback = playbackForRow(candidate.row);
        if (!playback || seen.has(playback.streamUrl)) {
            continue;
        }
        seen.add(playback.streamUrl);
        playbacks.push(playback);
    }
    return playbacks;
}

/**
 * Appends a continuation segment to the recording's main file and removes the
 * segment. MPEG-TS is append-safe, so the result plays as one file.
 */
export async function appendRecordingSegment(
    mainPath: string,
    segmentPath: string
): Promise<void> {
    if (!segmentPath || segmentPath === mainPath) {
        return;
    }
    try {
        const size = (await stat(segmentPath)).size;
        if (size > 0) {
            await appendFile(mainPath, await readFile(segmentPath));
        }
    } finally {
        await unlink(segmentPath).catch(() => undefined);
    }
}

/**
 * Keeps the main row honest while the recording continues in a new segment:
 * the row was filed when its own stream ended, but the file keeps growing.
 */
export async function touchRecordingRow(targetPath: string): Promise<void> {
    try {
        const size = (await stat(targetPath)).size;
        const db = await getDatabase();
        await db
            .update(schema.recordings)
            .set({
                status: 'recording',
                endedAt: null,
                fileSizeBytes: size,
                updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.recordings.filePath, targetPath));
        broadcastRecordingsUpdate();
    } catch (error) {
        console.warn('[Background recording] could not update the recording row:', error);
    }
}

/**
 * The last source hop ends the recording: the row of the main file was filed
 * when that file's own stream died, so it is completed here instead of being
 * left as an interrupted partial.
 */
export async function finalizeRecordingRow(
    targetPath: string,
    error?: string
): Promise<void> {
    try {
        const size = (await stat(targetPath)).size;
        const db = await getDatabase();
        await db
            .update(schema.recordings)
            .set({
                status: 'completed',
                endedAt: new Date().toISOString(),
                fileSizeBytes: size,
                ...(error ? { errorMessage: error } : {}),
                updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.recordings.filePath, targetPath));
        broadcastRecordingsUpdate();
    } catch (updateError) {
        console.warn(
            '[Background recording] could not finalize the recording row:',
            updateError
        );
    }
}
