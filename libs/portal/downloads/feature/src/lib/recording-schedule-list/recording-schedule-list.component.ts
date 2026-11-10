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
 * Pending scheduled recordings, shown above the recordings manager.
 *
 * The rows live in the main process (they fire with the window hidden), so
 * this list is read-only apart from cancel — it mirrors what will really be
 * recorded, not a renderer-side queue.
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

    isPending(id: number): boolean {
        return this.pendingIds().has(id);
    }

    cancel(schedule: RecordingScheduleItem): void {
        if (!this.isPending(schedule.id)) {
            this.cancelRequested.emit(schedule);
        }
    }
}
