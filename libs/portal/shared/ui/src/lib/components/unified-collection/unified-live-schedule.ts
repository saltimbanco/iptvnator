import { inject, Signal } from '@angular/core';
import { ResolvedLiveCollectionDetail } from '@iptvnator/portal/shared/data-access';
import { ScheduleRecordingLauncherService } from '@iptvnator/ui/components';
import { RecordingStartMetadata } from '@iptvnator/shared/interfaces';
import { UnifiedLiveTimeshift } from './unified-live-catchup';

/** The EPG programme a right-click asked to record. */
export interface ScheduleProgramWindow {
    start: string;
    stop: string;
    title: string;
    desc?: string | null;
}

export interface UnifiedLiveScheduleRecording {
    readonly available: boolean;
    /** EPG right-click: record the active channel for the programme's window. */
    open(program: ScheduleProgramWindow): void;
}

/**
 * Scheduling from this tab: the window comes from the programme, the channel
 * from the live selection. Skips catch-up playback, which is not the live
 * channel the schedule would record.
 */
export function createUnifiedLiveScheduleRecording(options: {
    metadata: Signal<RecordingStartMetadata | null>;
    activeDetail: Signal<ResolvedLiveCollectionDetail | null>;
    activeTimeshift: Signal<UnifiedLiveTimeshift | null>;
}): UnifiedLiveScheduleRecording {
    const launcher = inject(ScheduleRecordingLauncherService);
    return {
        available: launcher.isAvailable,
        open(program: ScheduleProgramWindow): void {
            const base = options.metadata();
            const playback = options.activeDetail()?.playback;
            if (!base || !playback?.streamUrl || options.activeTimeshift()) {
                return;
            }
            const metadata: RecordingStartMetadata = {
                ...base,
                currentProgram: {
                    title: program.title,
                    description: program.desc ?? undefined,
                    start: program.start,
                    stop: program.stop,
                },
            };
            launcher.open(
                { playback: { ...playback, isLive: true }, metadata },
                { startAt: program.start, endAt: program.stop }
            );
        },
    };
}
