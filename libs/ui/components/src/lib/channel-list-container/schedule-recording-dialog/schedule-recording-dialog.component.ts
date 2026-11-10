import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    signal,
} from '@angular/core';
import {
    MAT_DIALOG_DATA,
    MatDialog,
    MatDialogModule,
    MatDialogRef,
} from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type {
    ElectronBridgeErrorResult,
    RecordingStartMetadata,
    ResolvedPortalPlayback,
    StalkerScheduleRefresh,
} from '@iptvnator/shared/interfaces';
import { dialogSize } from '../../dialog-shell/dialog-size';

export interface ScheduleRecordingRange {
    /** ISO instant the recording starts at. */
    startAt: string;
    /** ISO instant the recording stops at. */
    endAt: string;
}

/** What the main process needs to record a channel the renderer resolved. */
export interface ScheduleRecordingTarget {
    playback: ResolvedPortalPlayback;
    metadata: RecordingStartMetadata;
    /** Stalker rows: lets the main process re-mint the link at start time. */
    refresh?: StalkerScheduleRefresh;
}

/** A preselected window, in local date and times (`YYYY-MM-DD`, `HH:mm`). */
export interface ScheduleRecordingInitialWindow {
    date: string;
    startTime: string;
    endTime: string;
}

export interface ScheduleRecordingDialogData {
    channelName: string;
    channelLogoUrl?: string | null;
    /**
     * Resolves the stream to record. Kept out of the caller's click handler
     * so the dialog opens before a portal handshake (a Stalker `create_link`)
     * finishes, instead of leaving the context menu frozen.
     */
    resolve?: () => Promise<ScheduleRecordingTarget | null>;
    /** Preselected window of a reschedule. */
    initial?: ScheduleRecordingInitialWindow;
    /** Overrides the primary button label; a reschedule reuses the dialog. */
    submitLabelKey?: string;
    /** Persists the schedule; the dialog only collects the time window. */
    submit: (
        range: ScheduleRecordingRange,
        target?: ScheduleRecordingTarget
    ) => Promise<ElectronBridgeErrorResult>;
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

export function toScheduleDateInput(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function toScheduleTimeInput(date: Date): string {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Minimum lead time: the recorder needs a moment to open the stream. */
const MIN_LEAD_MS = 60_000;

/**
 * The scheduler's calendar picker: one date, a start and an end time, and
 * nothing else. The channel comes from the right-click menu, so the dialog
 * never asks which stream to record.
 */
@Component({
    selector: 'app-schedule-recording-dialog',
    templateUrl: './schedule-recording-dialog.component.html',
    styleUrl: './schedule-recording-dialog.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        MatButtonModule,
        MatDialogModule,
        MatIconModule,
        TranslatePipe,
    ],
})
export class ScheduleRecordingDialogComponent {
    readonly data = inject<ScheduleRecordingDialogData>(MAT_DIALOG_DATA);
    private readonly ref =
        inject<MatDialogRef<ScheduleRecordingDialogComponent, boolean>>(
            MatDialogRef
        );

    private readonly initialWindow = ((): ScheduleRecordingInitialWindow => {
        if (this.data.initial) {
            return this.data.initial;
        }
        const start = new Date(Date.now() + MIN_LEAD_MS);
        start.setSeconds(0, 0);
        start.setMinutes(Math.ceil(start.getMinutes() / 5) * 5);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        return {
            date: toScheduleDateInput(start),
            startTime: toScheduleTimeInput(start),
            endTime: toScheduleTimeInput(end),
        };
    })();

    readonly date = signal(this.initialWindow.date);
    readonly startTime = signal(this.initialWindow.startTime);
    readonly endTime = signal(this.initialWindow.endTime);
    readonly saving = signal(false);
    readonly submitError = signal<string | null>(null);
    /** A Stalker row's link is minted while the dialog is already open. */
    readonly preparing = signal(typeof this.data.resolve === 'function');
    readonly prepareFailed = signal(false);
    readonly savedWindow = signal<string | null>(null);
    readonly saved = computed(() => this.savedWindow() !== null);
    readonly submitLabelKey =
        this.data.submitLabelKey ?? 'RECORDING_SCHEDULE.SAVE';

    private target: ScheduleRecordingTarget | null = null;

    /** Earliest date the picker offers: today. */
    readonly minDate = toScheduleDateInput(new Date());

    readonly startAt = computed(() =>
        this.combine(this.date(), this.startTime())
    );
    readonly endAt = computed(() => this.combine(this.date(), this.endTime()));

    readonly errorKey = computed(() => {
        const startMs = this.startAt();
        const endMs = this.endAt();
        if (startMs === null || endMs === null) {
            return 'RECORDING_SCHEDULE.ERROR_TIMES';
        }
        if (endMs <= startMs) {
            return 'RECORDING_SCHEDULE.ERROR_ORDER';
        }
        if (endMs <= Date.now()) {
            return 'RECORDING_SCHEDULE.ERROR_PAST';
        }
        return null;
    });

    constructor() {
        void this.prepare();
    }

    static open(dialog: MatDialog, data: ScheduleRecordingDialogData) {
        return dialog.open<
            ScheduleRecordingDialogComponent,
            ScheduleRecordingDialogData,
            boolean
        >(ScheduleRecordingDialogComponent, {
            ...dialogSize('sm'),
            data,
        });
    }

    setDate(event: Event): void {
        this.date.set((event.target as HTMLInputElement).value);
        this.submitError.set(null);
    }

    setStartTime(event: Event): void {
        this.startTime.set((event.target as HTMLInputElement).value);
        this.submitError.set(null);
    }

    setEndTime(event: Event): void {
        this.endTime.set((event.target as HTMLInputElement).value);
        this.submitError.set(null);
    }

    close(): void {
        this.ref.close(this.saved());
    }

    async submit(): Promise<void> {
        if (this.saved() || this.preparing() || this.prepareFailed()) {
            return;
        }
        const startMs = this.startAt();
        const endMs = this.endAt();
        if (startMs === null || endMs === null || this.errorKey()) {
            return;
        }

        this.saving.set(true);
        const result = await this.data.submit(
            {
                startAt: new Date(startMs).toISOString(),
                endAt: new Date(endMs).toISOString(),
            },
            this.target ?? undefined
        );
        this.saving.set(false);

        if (result.success) {
            // Stays open on a confirmation: the dialog closing silently was
            // the only feedback a user got for a saved schedule.
            this.savedWindow.set(
                `${this.date()} · ${this.startTime()}–${this.endTime()}`
            );
            return;
        }
        this.submitError.set(result.error ?? 'RECORDING_SCHEDULE.ERROR_SAVE');
    }

    private async prepare(): Promise<void> {
        const resolve = this.data.resolve;
        if (!resolve) {
            return;
        }
        try {
            this.target = await resolve();
            this.prepareFailed.set(this.target === null);
        } catch {
            this.target = null;
            this.prepareFailed.set(true);
        } finally {
            this.preparing.set(false);
        }
    }

    private combine(date: string, time: string): number | null {
        if (!date || !time) {
            return null;
        }
        const value = new Date(`${date}T${time}:00`).getTime();
        return Number.isFinite(value) ? value : null;
    }
}
