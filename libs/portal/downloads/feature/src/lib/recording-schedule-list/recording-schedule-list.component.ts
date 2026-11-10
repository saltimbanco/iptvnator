import { DatePipe } from '@angular/common';
import {
    ChangeDetectionStrategy,
    Component,
    input,
    output,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { RecordingScheduleItem } from '@iptvnator/shared/interfaces';

/**
 * Scheduled recordings, shown above the recordings manager.
 *
 * The rows live in the main process (they fire with the window hidden), so
 * this list mirrors what will really be recorded rather than a renderer-side
 * queue: a pending row can be rescheduled or canceled, and a finished row
 * keeps its outcome and reason so a recording that never happened is not
 * silently missing.
 */
@Component({
    selector: 'app-recording-schedule-list',
    templateUrl: './recording-schedule-list.component.html',
    styleUrl: './recording-schedule-list.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [DatePipe, MatButtonModule, MatIcon, TranslatePipe],
})
export class RecordingScheduleListComponent {
    readonly schedules = input.required<readonly RecordingScheduleItem[]>();
    readonly pendingIds = input<ReadonlySet<number>>(new Set());
    readonly cancelRequested = output<RecordingScheduleItem>();
    readonly rescheduleRequested = output<RecordingScheduleItem>();

    isPending(id: number): boolean {
        return this.pendingIds().has(id);
    }

    /** Only a schedule the main process has not fired yet can be changed. */
    canManage(schedule: RecordingScheduleItem): boolean {
        return schedule.status === 'pending' && !this.isPending(schedule.id);
    }

    statusKey(schedule: RecordingScheduleItem): string {
        return `RECORDING_SCHEDULE.STATUS_${schedule.status.toUpperCase()}`;
    }

    cancel(schedule: RecordingScheduleItem): void {
        if (this.canManage(schedule)) {
            this.cancelRequested.emit(schedule);
        }
    }

    reschedule(schedule: RecordingScheduleItem): void {
        if (this.canManage(schedule)) {
            this.rescheduleRequested.emit(schedule);
        }
    }
}
