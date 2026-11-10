import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import type {
    RecordingStartMetadata,
    ResolvedPortalPlayback,
    StalkerScheduleRefresh,
} from '@iptvnator/shared/interfaces';
import {
    RecordingSchedulesService,
    RuntimeCapabilitiesService,
} from '@iptvnator/services';
import { ScheduleRecordingDialogComponent } from './schedule-recording-dialog.component';

export interface ScheduleRecordingTarget {
    playback: ResolvedPortalPlayback;
    metadata: RecordingStartMetadata;
    /** Stalker rows: lets the main process re-mint the link at start time. */
    refresh?: StalkerScheduleRefresh;
}

/**
 * Opens the scheduler for a channel a list already resolved. Shared by every
 * channel list so the right-click row behaves the same everywhere and the
 * dialog only ever collects the time window.
 */
@Injectable({ providedIn: 'root' })
export class ScheduleRecordingLauncherService {
    private readonly dialog = inject(MatDialog);
    private readonly schedules = inject(RecordingSchedulesService);
    private readonly runtime = inject(RuntimeCapabilitiesService);

    get isAvailable(): boolean {
        return (
            this.runtime.supportsRecordingSchedule &&
            this.schedules.isAvailable() &&
            this.runtime.isElectron
        );
    }

    open(target: ScheduleRecordingTarget): void {
        if (!this.isAvailable || !target.playback.streamUrl) {
            return;
        }

        ScheduleRecordingDialogComponent.open(this.dialog, {
            channelName: target.metadata.channelName,
            channelLogoUrl: target.metadata.channelLogoUrl,
            submit: ({ startAt, endAt }) =>
                this.schedules.create({
                    playback: target.playback,
                    metadata: target.metadata,
                    refresh: target.refresh,
                    startAt,
                    endAt,
                }),
        });
    }
}
