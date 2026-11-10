import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import type {
    ElectronBridgeErrorResult,
    RecordingStartMetadata,
    ResolvedPortalPlayback,
    StalkerScheduleRefresh,
} from '@iptvnator/shared/interfaces';
import { RuntimeCapabilitiesService } from '@iptvnator/services';
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
 * dialog only ever collects the time window. It talks to the schedule bridge
 * itself instead of the recordings store: the store is only needed by the
 * downloads route, and importing it here would put it on the startup path.
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

        ScheduleRecordingDialogComponent.open(this.dialog, {
            channelName: target.metadata.channelName,
            channelLogoUrl: target.metadata.channelLogoUrl,
            submit: ({ startAt, endAt }) =>
                this.create(target, startAt, endAt),
        });
    }

    /** The main process broadcasts the new row, so no local refresh is needed. */
    private async create(
        target: ScheduleRecordingTarget,
        startAt: string,
        endAt: string
    ): Promise<ElectronBridgeErrorResult> {
        const bridge = typeof window === 'undefined' ? undefined : window.electron;
        if (typeof bridge?.recordingScheduleCreate !== 'function') {
            return { error: 'Scheduling is not available', success: false };
        }

        try {
            return (
                (await bridge.recordingScheduleCreate({
                    playback: target.playback,
                    metadata: target.metadata,
                    refresh: target.refresh,
                    startAt,
                    endAt,
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
