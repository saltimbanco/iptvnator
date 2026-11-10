import { ipcMain } from 'electron';
import {
    RECORDING_SCHEDULE_CANCEL,
    RECORDING_SCHEDULE_CREATE,
    RECORDING_SCHEDULE_GET_LIST,
    RECORDING_SCHEDULE_RESCHEDULE,
    type RecordingScheduleCreateRequest,
    type RecordingScheduleRescheduleRequest,
} from '@iptvnator/shared/interfaces';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../database/connection';
import * as schema from '../database/schema';
import { broadcastRecordingSchedulesUpdate } from '../events/database/recording-schedule-broadcast';
import { recordingSchedulerService } from '../services/recording-scheduler.service';
import { resolveScheduleWindow } from '../services/recording-schedule-window';

export default class RecordingScheduleEvents {
    static bootstrapRecordingScheduleEvents(): Electron.IpcMain {
        return ipcMain;
    }
}

function invalid(message: string): { error: string; success: false } {
    return { error: message, success: false };
}

async function findPendingSchedule(
    scheduleId: number
): Promise<
    | { row: schema.RecordingSchedule }
    | { error: { error: string; success: false } }
> {
    const db = await getDatabase();
    const rows = await db
        .select()
        .from(schema.recordingSchedules)
        .where(eq(schema.recordingSchedules.id, scheduleId))
        .limit(1);
    const row = rows[0];
    if (!row) {
        return { error: invalid('This schedule no longer exists.') };
    }
    if (row.status !== 'pending') {
        return { error: invalid('This schedule has already run.') };
    }
    return { row };
}

ipcMain.handle(RECORDING_SCHEDULE_GET_LIST, () =>
    recordingSchedulerService.list()
);

ipcMain.handle(
    RECORDING_SCHEDULE_CREATE,
    async (_event, request: RecordingScheduleCreateRequest) => {
        const playback = request?.playback;
        const metadata = request?.metadata;
        if (!playback?.streamUrl) {
            return invalid('There is no stream to record.');
        }
        if (!metadata?.channelName) {
            return invalid('The channel name is missing.');
        }
        if (playback.drm) {
            return invalid('DRM-protected channels cannot be recorded.');
        }
        const window = resolveScheduleWindow(request);
        if ('error' in window) {
            return invalid(window.error);
        }

        try {
            const db = await getDatabase();
            const result = await db.insert(schema.recordingSchedules).values({
                channelName: metadata.channelName,
                channelLogoUrl: metadata.channelLogoUrl,
                playlistId: metadata.playlistId,
                playlistName: metadata.playlistName,
                sourceType: metadata.sourceType,
                epgChannelId: metadata.epgChannelId,
                playbackJson: JSON.stringify(playback),
                metadataJson: JSON.stringify(metadata),
                refreshJson: request.refresh
                    ? JSON.stringify(request.refresh)
                    : null,
                startAt: window.window.startAt,
                endAt: window.window.endAt,
                status: 'pending',
            });
            const id = Number(result.lastInsertRowid);
            await recordingSchedulerService.reload();
            broadcastRecordingSchedulesUpdate();
            return { success: true, id };
        } catch (error) {
            console.error('[Recording schedule] create failed:', error);
            return invalid(
                error instanceof Error ? error.message : 'Scheduling failed.'
            );
        }
    }
);

ipcMain.handle(
    RECORDING_SCHEDULE_RESCHEDULE,
    async (_event, request: RecordingScheduleRescheduleRequest) => {
        const scheduleId = Number(request?.scheduleId);
        if (!Number.isInteger(scheduleId)) {
            return invalid('This schedule no longer exists.');
        }
        const window = resolveScheduleWindow(request);
        if ('error' in window) {
            return invalid(window.error);
        }

        try {
            const found = await findPendingSchedule(scheduleId);
            if ('error' in found) {
                return found.error;
            }
            const db = await getDatabase();
            await db
                .update(schema.recordingSchedules)
                .set({
                    startAt: window.window.startAt,
                    endAt: window.window.endAt,
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(schema.recordingSchedules.id, scheduleId));
            await recordingSchedulerService.reload();
            broadcastRecordingSchedulesUpdate();
            return { success: true };
        } catch (error) {
            console.error('[Recording schedule] reschedule failed:', error);
            return invalid(
                error instanceof Error
                    ? error.message
                    : 'Rescheduling failed.'
            );
        }
    }
);

ipcMain.handle(
    RECORDING_SCHEDULE_CANCEL,
    async (_event, scheduleId: number) => {
        try {
            const found = await findPendingSchedule(Number(scheduleId));
            if ('error' in found) {
                return found.error;
            }
            const db = await getDatabase();
            await db
                .update(schema.recordingSchedules)
                .set({
                    status: 'canceled',
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(schema.recordingSchedules.id, Number(scheduleId)));
            await recordingSchedulerService.reload();
            broadcastRecordingSchedulesUpdate();
            return { success: true };
        } catch (error) {
            console.error('[Recording schedule] cancel failed:', error);
            return invalid(
                error instanceof Error ? error.message : 'Cancel failed.'
            );
        }
    }
);

export function startRecordingScheduler(): Promise<void> {
    return recordingSchedulerService.start();
}

export function shutdownRecordingScheduler(): void {
    recordingSchedulerService.shutdown();
}
