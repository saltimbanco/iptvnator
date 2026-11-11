import { computed, inject, Injectable, OnDestroy, signal } from '@angular/core';
import type { BackgroundRecordingState } from '@iptvnator/shared/interfaces';
import { RuntimeCapabilitiesService } from './runtime-capabilities.service';

/** A scheduled recording that just started; drives the renderer popup. */
export interface ScheduledRecordingNotice {
    readonly recordingId: string;
    readonly channelName: string;
    readonly startedAt?: string;
    readonly endsAt?: string;
}

/**
 * The renderer's view of the main process DVR recorder.
 *
 * Background recordings are owned by the main process (they must survive a
 * hidden window and a renderer reload), so the renderer has no local state to
 * read: this mirrors `RECORDING_ACTIVE_STATE` pushes and turns the first
 * transition into a `recording` of a schedule into a one-shot notice. The
 * notice is what the shell shows as a popup — the OS toast is the only other
 * feedback, and it is easy to miss while the window is open.
 */
@Injectable({ providedIn: 'root' })
export class BackgroundRecordingStateService implements OnDestroy {
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private unsubscribe?: () => void;
    /** Set once a schedule's start has been announced in this renderer. */
    private announcedRecordingId: string | null = null;

    readonly state = signal<BackgroundRecordingState | null>(null);
    readonly notice = signal<ScheduledRecordingNotice | null>(null);

    readonly isRecording = computed(() => {
        const status = this.state()?.status;
        return (
            status === 'starting' ||
            status === 'recording' ||
            status === 'reconnecting'
        );
    });

    constructor() {
        this.init();
    }

    dismissNotice(): void {
        this.notice.set(null);
    }

    ngOnDestroy(): void {
        this.unsubscribe?.();
    }

    private init(): void {
        if (!this.runtime.supportsRecordings) {
            return;
        }
        this.unsubscribe = window.electron.onBackgroundRecordingState?.(
            (state) => this.apply(state)
        );
        // A renderer reload during a scheduled recording must still show the
        // popup once, so seed from the current main-process state.
        void window.electron
            .backgroundRecordingGetState?.()
            .then((state) => this.apply(state))
            .catch(() => undefined);
    }

    private apply(state: BackgroundRecordingState | null): void {
        if (!state) {
            return;
        }
        this.state.set(state);
        if (state.status === 'idle' || state.status === 'stopping') {
            this.announcedRecordingId = null;
            return;
        }
        if (
            state.status !== 'recording' ||
            state.origin !== 'schedule' ||
            !state.recordingId ||
            state.recordingId === this.announcedRecordingId
        ) {
            return;
        }
        this.announcedRecordingId = state.recordingId;
        this.notice.set({
            recordingId: state.recordingId,
            channelName: state.channelName ?? '',
            startedAt: state.startedAt,
            endsAt: state.endsAt,
        });
    }
}
