import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import type {
    ElectronBridgeErrorResult,
    RecordingScheduleItem,
} from '@iptvnator/shared/interfaces';
import { RuntimeCapabilitiesService } from '@iptvnator/services';
import {
    ScheduleRecordingDialogComponent,
    type ScheduleRecordingDialogData,
    type ScheduleRecordingRange,
    type ScheduleRecordingTarget,
    toScheduleDateInput,
    toScheduleTimeInput,
} from './schedule-recording-dialog.component';

/** A channel whose stream still has to be resolved when the dialog opens. */
export interface DeferredScheduleRecordingRequest {
    channelName: string;
    channelLogoUrl?: string | null;
    /** `null` when the stream cannot be resolved; the dialog says so. */
    resolve: () => Promise<ScheduleRecordingTarget | null>;
}

/**
 * Opens the scheduler for a channel. Shared by every channel list so the
 * right-click row behaves the same everywhere and the dialog only ever
 * collects the time window. It talks to the schedule bridge itself instead
 * of the recordings store: the store is only needed by the downloads route,
 * and importing it here would put it on the startup path.
 *
 * A list that already resolved its stream calls `open`; a Stalker row calls
 * `openDeferred`, so the dialog appears at once and the portal handshake
 * runs inside it instead of delaying the menu action.
 */
@Injectable({ providedIn: 'root' })
export class ScheduleRecordingLauncherService {
    private readonly dialog = inject(MatDialog);
    private readonly runtime = inject(RuntimeCapabilitiesService);

    get isAvailable(): boolean {
        return this.runtime.supportsRecordingSchedule;
    }

    open(target: ScheduleRecordingTarget): void {
        if (!this.isAvailable || !target.playback.streamUrl) {
            return;
        }
        this.openDialog({
            channelName: target.metadata.channelName,
            channelLogoUrl: target.metadata.channelLogoUrl,
            resolve: async () => target,
            submit: (range) => this.create(target, range),
        });
    }

    openDeferred(source: DeferredScheduleRecordingRequest): void {
        if (!this.isAvailable || !source.channelName) {
            return;
        }
        this.openDialog({
            channelName: source.channelName,
            channelLogoUrl: source.channelLogoUrl,
            resolve: source.resolve,
            submit: (range, target) =>
                target
                    ? this.create(target, range)
                    : Promise.resolve({
                          error: 'Scheduling is not available',
                          success: false,
                      }),
        });
    }

    /** Moves a pending schedule; the channel it records stays the same. */
    reschedule(schedule: RecordingScheduleItem): void {
        if (!this.isAvailable) {
            return;
        }
        const start = new Date(schedule.startAt);
        const end = new Date(schedule.endAt);
        if (
            !Number.isFinite(start.getTime()) ||
            !Number.isFinite(end.getTime())
        ) {
            return;
        }
        this.openDialog({
            channelName: schedule.channelName,
            channelLogoUrl: schedule.channelLogoUrl,
            initial: {
                date: toScheduleDateInput(start),
                startTime: toScheduleTimeInput(start),
                endTime: toScheduleTimeInput(end),
            },
            submitLabelKey: 'RECORDING_SCHEDULE.RESCHEDULE',
            submit: (range) => this.update(schedule.id, range),
        });
    }

    private openDialog(data: ScheduleRecordingDialogData): void {
        ScheduleRecordingDialogComponent.open(this.dialog, data);
    }

    /** The main process broadcasts the new row, so no local refresh is needed. */
    private async create(
        target: ScheduleRecordingTarget,
        range: ScheduleRecordingRange
    ): Promise<ElectronBridgeErrorResult> {
        const bridge =
            typeof window === 'undefined' ? undefined : window.electron;
        if (typeof bridge?.recordingScheduleCreate !== 'function') {
            return { error: 'Scheduling is not available', success: false };
        }

        try {
            return (
                (await bridge.recordingScheduleCreate({
                    playback: target.playback,
                    metadata: target.metadata,
                    refresh: target.refresh,
                    startAt: range.startAt,
                    endAt: range.endAt,
                })) ?? { error: 'Scheduling bridge unavailable', success: false }
            );
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : String(error),
                success: false,
            };
        }
    }

    private async update(
        scheduleId: number,
        range: ScheduleRecordingRange
    ): Promise<ElectronBridgeErrorResult> {
        const bridge =
            typeof window === 'undefined' ? undefined : window.electron;
        if (typeof bridge?.recordingScheduleReschedule !== 'function') {
            return { error: 'Rescheduling is not available', success: false };
        }

        try {
            return (
                (await bridge.recordingScheduleReschedule({
                    scheduleId,
                    startAt: range.startAt,
                    endAt: range.endAt,
                })) ?? { error: 'Scheduling bridge unavailable', success: false }
            );
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : String(error),
                success: false,
            };
        }
    }
}
