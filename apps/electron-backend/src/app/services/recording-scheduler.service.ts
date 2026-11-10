import type {
    BackgroundRecordingStartRequest,
    RecordingScheduleItem,
    RecordingScheduleStatus,
    RecordingStartMetadata,
    ResolvedPortalPlayback,
    StalkerScheduleRefresh,
} from '@iptvnator/shared/interfaces';
import { asc, eq } from 'drizzle-orm';
import { getDatabase } from '../database/connection';
import * as schema from '../database/schema';
import { broadcastRecordingSchedulesUpdate } from '../events/database/recording-schedule-broadcast';
import { backgroundRecordingService } from './background-recording.runtime';
import { refreshStalkerSchedulePlayback } from './stalker-schedule-refresh.service';

type ScheduleRow = schema.RecordingSchedule;

/** setTimeout's limit; a schedule further out is re-armed when it fires. */
const MAX_TIMER_MS = 2_147_483_647;

function parseJson<T>(raw: string | null): T | null {
    if (!raw) {
        return null;
    }
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Owns scheduled recordings in the main process. The renderer only writes
 * rows; every timer, the start and the outcome live here, so a schedule
 * fires while the window is hidden in the tray or has been closed to it.
 *
 * At the start instant the stored playback is handed to the background
 * recorder, which owns the connection and writes the file. A Stalker row
 * additionally carries the portal command, so its short-lived `create_link`
 * URL is re-minted right before the start; the stored link is only the
 * fallback for a portal that cannot be reached.
 */
export class RecordingSchedulerService {
    private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
    private loaded = false;

    /** Loads pending rows and arms their timers; safe to call repeatedly. */
    async start(): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        await this.reload();
    }

    /** Re-reads pending rows; called after a create or a cancel. */
    async reload(): Promise<void> {
        this.clearTimers();
        let rows: ScheduleRow[];
        try {
            const db = await getDatabase();
            rows = await db
                .select()
                .from(schema.recordingSchedules)
                .where(eq(schema.recordingSchedules.status, 'pending'))
                .orderBy(asc(schema.recordingSchedules.startAt));
        } catch (error) {
            console.error('[Recording schedule] load failed:', error);
            return;
        }

        for (const row of rows) {
            this.arm(row);
        }
    }

    /** Newest first, for the manager and the rail badge. */
    async list(): Promise<RecordingScheduleItem[]> {
        const db = await getDatabase();
        const rows = await db
            .select()
            .from(schema.recordingSchedules)
            .orderBy(asc(schema.recordingSchedules.startAt));
        return rows.map((row) => this.toItem(row));
    }

    shutdown(): void {
        this.clearTimers();
        this.loaded = false;
    }

    private clearTimers(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }

    private arm(row: ScheduleRow): void {
        const startMs = Date.parse(row.startAt);
        const endMs = Date.parse(row.endAt);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
            void this.mark(row.id, 'failed', 'The scheduled time is invalid.');
            return;
        }
        if (Date.now() >= endMs) {
            // Missed entirely (app was off for the whole window).
            void this.mark(row.id, 'failed', 'The scheduled time has passed.');
            return;
        }
        if (startMs <= Date.now()) {
            // Already inside the window: start now so a late launch still
            // records the remainder instead of skipping it.
            void this.fire(row.id);
            return;
        }

        const delay = Math.min(startMs - Date.now(), MAX_TIMER_MS);
        const timer = setTimeout(() => {
            this.timers.delete(row.id);
            const remaining = Date.parse(row.startAt) - Date.now();
            if (remaining > 0) {
                void this.reload();
                return;
            }
            void this.fire(row.id);
        }, delay);
        this.timers.set(row.id, timer);
    }

    private async fire(id: number): Promise<void> {
        let row: ScheduleRow | undefined;
        try {
            const db = await getDatabase();
            const rows = await db
                .select()
                .from(schema.recordingSchedules)
                .where(eq(schema.recordingSchedules.id, id))
                .limit(1);
            row = rows[0];
        } catch (error) {
            console.error('[Recording schedule] lookup failed:', error);
            return;
        }

        if (!row || row.status !== 'pending') {
            return;
        }
        if (!(Date.parse(row.endAt) > Date.now())) {
            await this.mark(id, 'failed', 'The scheduled time has passed.');
            return;
        }

        const storedPlayback = parseJson<ResolvedPortalPlayback>(
            row.playbackJson
        );
        const metadata = parseJson<RecordingStartMetadata>(row.metadataJson);
        if (!storedPlayback?.streamUrl || !metadata) {
            await this.mark(
                id,
                'failed',
                'The channel link could not be restored.'
            );
            return;
        }

        const playback = await this.withFreshPlayback(row, storedPlayback);
        const request: BackgroundRecordingStartRequest = {
            playback,
            metadata,
            origin: 'schedule',
            endsAt: row.endAt,
        };

        try {
            const state = backgroundRecordingService.start(request);
            await this.mark(id, 'started', undefined, state.recordingId);
        } catch (error) {
            await this.mark(id, 'failed', messageOf(error));
        }
    }

    /**
     * Stalker links are minted for the session that asked, and portals expire
     * them long before a schedule fires. Minting a fresh one here is what
     * makes a Stalker schedule usable for a start time hours away; the stored
     * link still covers a portal that is offline at the start instant.
     */
    private async withFreshPlayback(
        row: ScheduleRow,
        stored: ResolvedPortalPlayback
    ): Promise<ResolvedPortalPlayback> {
        const refresh = parseJson<StalkerScheduleRefresh>(row.refreshJson);
        if (refresh?.kind !== 'stalker') {
            return stored;
        }

        const fresh = await refreshStalkerSchedulePlayback(
            {
                refresh,
                playlistId: row.playlistId,
                title: stored.title,
                thumbnail: stored.thumbnail,
            },
            { getPortal: (playlistId) => this.loadPortal(playlistId) }
        );
        if (fresh) {
            return fresh;
        }

        console.warn(
            '[Recording schedule] Stalker link refresh failed; using the stored link.',
            { scheduleId: row.id }
        );
        return stored;
    }

    private async loadPortal(
        playlistId: string
    ): Promise<{ portalUrl: string; macAddress: string } | null> {
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

    private async mark(
        id: number,
        status: RecordingScheduleStatus,
        errorMessage?: string,
        recordingId?: string
    ): Promise<void> {
        try {
            const db = await getDatabase();
            await db
                .update(schema.recordingSchedules)
                .set({
                    status,
                    errorMessage: errorMessage ?? null,
                    recordingId: recordingId ?? null,
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(schema.recordingSchedules.id, id));
        } catch (error) {
            console.error('[Recording schedule] update failed:', error);
            return;
        }
        broadcastRecordingSchedulesUpdate();
    }

    private toItem(row: ScheduleRow): RecordingScheduleItem {
        return {
            id: row.id,
            channelName: row.channelName,
            channelLogoUrl: row.channelLogoUrl ?? undefined,
            playlistId: row.playlistId ?? undefined,
            playlistName: row.playlistName ?? undefined,
            sourceType: row.sourceType ?? undefined,
            startAt: row.startAt,
            endAt: row.endAt,
            status: row.status,
            errorMessage: row.errorMessage ?? undefined,
            recordingId: row.recordingId ?? undefined,
        };
    }
}

export const recordingSchedulerService = new RecordingSchedulerService();
