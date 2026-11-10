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
import type { ElectronBridgeErrorResult } from '@iptvnator/shared/interfaces';
import { dialogSize } from '../../dialog-shell/dialog-size';

export interface ScheduleRecordingRange {
    /** ISO instant the recording starts at. */
    startAt: string;
    /** ISO instant the recording stops at. */
    endAt: string;
}

export interface ScheduleRecordingDialogData {
    channelName: string;
    channelLogoUrl?: string | null;
    /** Persists the schedule; the dialog only collects the time window. */
    submit: (
        range: ScheduleRecordingRange
    ) => Promise<ElectronBridgeErrorResult>;
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

function toDateInput(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toTimeInput(date: Date): string {
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

    private readonly defaults = (() => {
        const start = new Date(Date.now() + MIN_LEAD_MS);
        start.setSeconds(0, 0);
        start.setMinutes(Math.ceil(start.getMinutes() / 5) * 5);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        return { start, end };
    })();

    readonly date = signal(toDateInput(this.defaults.start));
    readonly startTime = signal(toTimeInput(this.defaults.start));
    readonly endTime = signal(toTimeInput(this.defaults.end));
    readonly saving = signal(false);
    readonly submitError = signal<string | null>(null);

    /** Earliest date the picker offers: today. */
    readonly minDate = toDateInput(new Date());

    readonly startAt = computed(() => this.combine(this.date(), this.startTime()));
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
        this.ref.close(false);
    }

    async submit(): Promise<void> {
        const startMs = this.startAt();
        const endMs = this.endAt();
        if (startMs === null || endMs === null || this.errorKey()) {
            return;
        }

        this.saving.set(true);
        const result = await this.data.submit({
            startAt: new Date(startMs).toISOString(),
            endAt: new Date(endMs).toISOString(),
        });
        this.saving.set(false);

        if (result.success) {
            this.ref.close(true);
            return;
        }
        this.submitError.set(
            result.error ?? 'RECORDING_SCHEDULE.ERROR_SAVE'
        );
    }

    private combine(date: string, time: string): number | null {
        if (!date || !time) {
            return null;
        }
        const value = new Date(`${date}T${time}:00`).getTime();
        return Number.isFinite(value) ? value : null;
    }
}
