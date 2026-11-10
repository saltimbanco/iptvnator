import { ipcMain } from 'electron';
import {
    RECORDING_SCHEDULE_CANCEL,
    RECORDING_SCHEDULE_CREATE,
    RECORDING_SCHEDULE_GET_LIST,
    type RecordingScheduleCreateRequest,
} from '@iptvnator/shared/interfaces';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../database/connection';
import * as schema from '../database/schema';
import { broadcastRecordingSchedulesUpdate } from '../events/database/recording-schedule-broadcast';
import { recordingSchedulerService } from '../services/recording-scheduler.service';

export default class RecordingScheduleEvents {
    static bootstrapRecordingScheduleEvents(): Electron.IpcMain {
        return ipcMain;
    }
}

function invalid(message: string): { error: string; success: false } {
    return { error: message, success: false };
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
        const startMs = Date.parse(request.startAt);
        const endMs = Date.parse(request.endAt);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
            return invalid('Pick a start and an end time.');
        }
        if (endMs <= startMs) {
            return invalid('The end time must be after the start time.');
        }
        if (endMs <= Date.now()) {
            return invalid('The scheduled time has already passed.');
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
                startAt: request.startAt,
                endAt: request.endAt,
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
    RECORDING_SCHEDULE_CANCEL,
    async (_event, scheduleId: number) => {
        try {
            const db = await getDatabase();
            const rows = await db
                .select()
                .from(schema.recordingSchedules)
                .where(eq(schema.recordingSchedules.id, scheduleId))
                .limit(1);
            const row = rows[0];
            if (!row) {
                return invalid('This schedule no longer exists.');
            }
            if (row.status !== 'pending') {
                return invalid('This schedule has already run.');
            }
            await db
                .update(schema.recordingSchedules)
                .set({
                    status: 'canceled',
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(schema.recordingSchedules.id, scheduleId));
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
