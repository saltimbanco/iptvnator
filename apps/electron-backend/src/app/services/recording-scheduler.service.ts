import type {
    BackgroundRecordingOutcome,
    BackgroundRecordingStartRequest,
    RecordingScheduleItem,
    RecordingScheduleStatus,
    RecordingStartMetadata,
    ResolvedPortalPlayback,
    StalkerScheduleRefresh,
} from '@iptvnator/shared/interfaces';
import { asc, desc, eq, ne } from 'drizzle-orm';
import { getDatabase } from '../database/connection';
import * as schema from '../database/schema';
import { broadcastRecordingSchedulesUpdate } from '../events/database/recording-schedule-broadcast';
import { backgroundRecordingService } from './background-recording.runtime';
import {
    type RecordingScheduleNotification,
    notifyRecordingSchedule,
} from './recording-schedule-notify';
import {
    loadStalkerSchedulePortal,
    refreshStalkerSchedulePlayback,
} from './stalker-schedule-refresh.service';

type ScheduleRow = schema.RecordingSchedule;

/** setTimeout's limit; a schedule further out is re-armed when it fires. */
const MAX_TIMER_MS = 2_147_483_647;

/** Finished rows the manager keeps showing; pending rows are always all. */
const RECENT_FINISHED_LIMIT = 25;

export interface RecordingSchedulerDeps {
    /** Toast for a started or failed schedule; tests replace it. */
    readonly notify?: (notification: RecordingScheduleNotification) => void;
}

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
 *
 * Every outcome is logged and toasted: a schedule that fails while the
 * window is hidden would otherwise disappear without a trace.
 */
export class RecordingSchedulerService {
    private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
    private loaded = false;

    constructor(private readonly deps: RecordingSchedulerDeps = {}) {
        backgroundRecordingService.setOutcomeListener((request, outcome) =>
            this.reportRecordingOutcome(request, outcome)
        );
    }

    /**
     * A schedule is marked as started at handover, before the recorder has
     * opened the stream. When the recording then ends having written nothing
     * — a dead link, a recorder that never started — the row must stop
     * claiming it is recording, and say why instead.
     */
    private reportRecordingOutcome(
        request: BackgroundRecordingStartRequest,
        outcome: BackgroundRecordingOutcome
    ): void {
        const scheduleId = request.scheduleId;
        if (typeof scheduleId !== 'number' || outcome.recordedBytes > 0) {
            return;
        }
        void this.failById(
            scheduleId,
            request.metadata?.channelName ?? '',
            outcome.error ?? 'Nothing was recorded.'
        );
    }

    /** Loads pending rows and arms their timers; safe to call repeatedly. */
    async start(): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        console.info('[Recording schedule] background recorder', {
            available: backgroundRecordingService.isAvailable(),
        });
        await this.reload();
    }

    /** Re-reads pending rows; called after a create, a reschedule or a cancel. */
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
        console.info('[Recording schedule] armed', { pending: rows.length });
    }

    /**
     * Pending rows first, then the latest finished ones. A long-lived install
     * accumulates rows, and the manager only needs the recent outcomes, so
     * the query stays bounded instead of shipping the whole history to the
     * renderer on every update.
     */
    async list(): Promise<RecordingScheduleItem[]> {
        const db = await getDatabase();
        const pending = await db
            .select()
            .from(schema.recordingSchedules)
            .where(eq(schema.recordingSchedules.status, 'pending'))
            .orderBy(asc(schema.recordingSchedules.startAt));
        const finished = await db
            .select()
            .from(schema.recordingSchedules)
            .where(ne(schema.recordingSchedules.status, 'pending'))
            .orderBy(desc(schema.recordingSchedules.updatedAt))
            .limit(RECENT_FINISHED_LIMIT);
        return [...pending, ...finished].map((row) => this.toItem(row));
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
            void this.fail(row, 'The scheduled time is invalid.');
            return;
        }
        if (Date.now() >= endMs) {
            // Missed entirely (app was off for the whole window).
            void this.fail(row, 'The scheduled time has passed.');
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
            await this.fail(row, 'The scheduled time has passed.');
            return;
        }

        console.info('[Recording schedule] starting', {
            id: row.id,
            channelName: row.channelName,
            startAt: row.startAt,
            endAt: row.endAt,
            recorderAvailable: backgroundRecordingService.isAvailable(),
        });

        const storedPlayback = parseJson<ResolvedPortalPlayback>(
            row.playbackJson
        );
        const metadata = parseJson<RecordingStartMetadata>(row.metadataJson);
        if (!storedPlayback?.streamUrl || !metadata) {
            await this.fail(row, 'The channel link could not be restored.');
            return;
        }

        const refresh = parseJson<StalkerScheduleRefresh>(row.refreshJson);
        const playback = await this.withFreshPlayback(
            row,
            storedPlayback,
            refresh
        );
        const request: BackgroundRecordingStartRequest = {
            playback,
            metadata,
            origin: 'schedule',
            endsAt: row.endAt,
            scheduleId: row.id,
            ...(refresh ? { refresh } : {}),
        };

        try {
            const state = backgroundRecordingService.start(request);
            await this.mark(id, 'started', undefined, state.recordingId);
            console.info('[Recording schedule] recording started', {
                id,
                channelName: row.channelName,
                recordingId: state.recordingId,
            });
            this.notify({
                title: 'Recording started',
                body: `${row.channelName} — ${this.describeWindow(row)}`,
            });
        } catch (error) {
            await this.fail(row, messageOf(error));
        }
    }

    private describeWindow(row: ScheduleRow): string {
        const start = new Date(row.startAt);
        const end = new Date(row.endAt);
        if (
            !Number.isFinite(start.getTime()) ||
            !Number.isFinite(end.getTime())
        ) {
            return '';
        }
        return `${start.toLocaleString()} – ${end.toLocaleTimeString()}`;
    }

    /**
     * Stalker links are minted for the session that asked, and portals expire
     * them long before a schedule fires. Minting a fresh one here is what
     * makes a Stalker schedule usable for a start time hours away; the stored
     * link still covers a portal that is offline at the start instant.
     */
    private async withFreshPlayback(
        row: ScheduleRow,
        stored: ResolvedPortalPlayback,
        refresh: StalkerScheduleRefresh | null
    ): Promise<ResolvedPortalPlayback> {
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
            { getPortal: loadStalkerSchedulePortal }
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

    /** Records why a schedule did not record and tells the user about it. */
    private async fail(row: ScheduleRow, reason: string): Promise<void> {
        await this.failById(row.id, row.channelName, reason);
    }

    private async failById(
        id: number,
        channelName: string,
        reason: string
    ): Promise<void> {
        console.warn('[Recording schedule] failed', {
            id,
            channelName,
            reason,
        });
        this.notify({
            title: 'Scheduled recording failed',
            body: `${channelName}: ${reason}`,
        });
        await this.mark(id, 'failed', reason);
    }

    private notify(notification: RecordingScheduleNotification): void {
        (this.deps.notify ?? notifyRecordingSchedule)(notification);
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
