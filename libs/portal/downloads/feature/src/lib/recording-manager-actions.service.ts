import { Injectable, inject, signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import {
    type RecordingItem,
    RecordingsService,
    RecordingSchedulesService,
} from '@iptvnator/services';
import type { RecordingScheduleItem } from '@iptvnator/shared/interfaces';
import { DialogService } from '@iptvnator/ui/components';
import type {
    RecordingActionResult,
    RecordingItemAction,
} from './recording-actions';

interface RecordingOperationResult {
    readonly success: boolean;
    readonly error?: string;
}

/** Mirror of DownloadManagerActionsService for recording rows. */
@Injectable()
export class RecordingManagerActionsService {
    private readonly recordings = inject(RecordingsService);
    private readonly schedules = inject(RecordingSchedulesService);
    private readonly dialogs = inject(DialogService);
    private readonly translate = inject(TranslateService);
    private readonly snackBar = inject(MatSnackBar);
    private readonly router = inject(Router);

    readonly pendingIds = signal<ReadonlySet<number>>(new Set());
    readonly pendingScheduleIds = signal<ReadonlySet<number>>(new Set());

    async run(action: RecordingItemAction): Promise<RecordingActionResult> {
        const { item, type } = action;
        if (this.pendingIds().has(item.id)) {
            return 'ignored';
        }
        switch (type) {
            case 'remove':
                this.confirmRemove(item);
                return 'ignored';
            case 'stop':
                return this.withPending(item.id, () =>
                    this.recordings.stopRecording(item.id)
                );
            case 'play':
                return this.playInApp(item);
            case 'reveal':
                return this.runFileAction(type, item);
            case 'open-detail':
                return 'ignored';
        }
    }

    /** Cancel a pending schedule in the main process that owns its timer. */
    async cancelSchedule(
        schedule: RecordingScheduleItem
    ): Promise<RecordingActionResult> {
        if (this.pendingScheduleIds().has(schedule.id)) {
            return 'ignored';
        }
        this.pendingScheduleIds.update((ids) => new Set(ids).add(schedule.id));
        try {
            const result = await this.schedules.cancel(schedule.id);
            if (!result.success) {
                this.showMessage('RECORDING_SCHEDULE.CANCEL_FAILED', 4000);
                return 'failed';
            }
            this.showMessage('RECORDING_SCHEDULE.CANCELED', 4000);
            return 'success';
        } catch (error) {
            this.showActionError(
                error instanceof Error ? error.message : String(error)
            );
            return 'failed';
        } finally {
            this.pendingScheduleIds.update((ids) => {
                const next = new Set(ids);
                next.delete(schedule.id);
                return next;
            });
        }
    }

    showActionError(error?: string): void {
        const base = this.translate.instant('DOWNLOADS.ACTION_FAILED');
        this.snackBar.open(error ? `${base}: ${error}` : base, undefined, {
            duration: 4000,
        });
    }

    private showMessage(key: string, duration: number): void {
        this.snackBar.open(this.translate.instant(key), undefined, {
            duration,
        });
    }

    private confirmRemove(item: RecordingItem): void {
        this.dialogs.openConfirmDialog({
            title: this.translate.instant(
                'DOWNLOADS.REMOVE_RECORDING_DIALOG.TITLE'
            ),
            message: this.translate.instant(
                'DOWNLOADS.REMOVE_RECORDING_DIALOG.MESSAGE'
            ),
            confirmLabel: this.translate.instant(
                'DOWNLOADS.REMOVE_FROM_MANAGER'
            ),
            tone: 'destructive',
            onConfirm: () =>
                this.withPending(item.id, () =>
                    this.recordings.removeRecording(item.id)
                ),
        });
    }

    /** Playback happens in IPTVnator's own player, not the OS default app. */
    private async playInApp(
        item: RecordingItem
    ): Promise<RecordingActionResult> {
        if (!item.filePath) {
            this.showMessage('DOWNLOADS.FILE_NOT_FOUND', 3000);
            return 'file-missing';
        }
        try {
            const navigated = await this.router.navigate([
                '/workspace',
                'downloads',
                'recording-player',
                String(item.id),
            ]);
            return navigated ? 'success' : 'failed';
        } catch {
            return 'failed';
        }
    }

    private async runFileAction(
        type: 'play' | 'reveal',
        item: RecordingItem
    ): Promise<RecordingActionResult> {
        const filePath = item.filePath;
        if (!filePath) {
            this.showMessage('DOWNLOADS.FILE_NOT_FOUND', 3000);
            return 'file-missing';
        }
        return this.withPending(
            item.id,
            () =>
                type === 'play'
                    ? this.recordings.playFile(filePath)
                    : this.recordings.revealFile(filePath),
            async (error) => {
                if (error === 'File not found') {
                    // Refresh so the row moves to Needs attention honestly.
                    await this.recordings.loadRecordings();
                }
                this.showMessage(
                    error === 'File not found'
                        ? 'DOWNLOADS.FILE_NOT_FOUND'
                        : 'DOWNLOADS.FILE_ACTION_ERROR',
                    3000
                );
            },
            (error) => (error === 'File not found' ? 'file-missing' : 'failed')
        );
    }

    private async withPending(
        itemId: number,
        operation: () => Promise<RecordingOperationResult>,
        onFailure: (error?: string) => void | Promise<void> = (error) =>
            this.showActionError(error),
        failureResult: (error?: string) => RecordingActionResult = () =>
            'failed'
    ): Promise<RecordingActionResult> {
        if (this.pendingIds().has(itemId)) {
            return 'ignored';
        }
        this.pendingIds.update((ids) => new Set(ids).add(itemId));
        try {
            let failure: string | undefined;
            let failed = false;
            try {
                const result = await operation();
                failed = !result.success;
                failure = result.error;
            } catch (error) {
                failed = true;
                failure =
                    error instanceof Error ? error.message : String(error);
            }
            if (failed) {
                try {
                    await onFailure(failure);
                } catch (error) {
                    this.showActionError(
                        error instanceof Error ? error.message : String(error)
                    );
                }
                return failureResult(failure);
            }
            return 'success';
        } finally {
            this.pendingIds.update((ids) => {
                const next = new Set(ids);
                next.delete(itemId);
                return next;
            });
        }
    }
}
