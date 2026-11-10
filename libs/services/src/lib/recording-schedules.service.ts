import { computed, inject, Injectable, OnDestroy, signal } from '@angular/core';
import type {
    ElectronBridgeErrorResult,
    RecordingScheduleCreateRequest,
    RecordingScheduleItem,
} from '@iptvnator/shared/interfaces';
import { RuntimeCapabilitiesService } from './runtime-capabilities.service';

/**
 * Scheduled recordings as the renderer sees them. The main process owns the
 * timers; this store only mirrors the rows and forwards create/cancel, so a
 * schedule survives a renderer reload and fires with the window hidden.
 */
@Injectable({ providedIn: 'root' })
export class RecordingSchedulesService implements OnDestroy {
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private unsubscribe?: () => void;

    readonly schedules = signal<RecordingScheduleItem[]>([]);
    readonly isAvailable = computed(() => this.runtime.supportsRecordingSchedule);
    readonly pending = computed(() =>
        this.schedules().filter((schedule) => schedule.status === 'pending')
    );

    constructor() {
        if (this.isAvailable()) {
            this.unsubscribe = window.electron?.onRecordingSchedulesUpdate?.(
                () => void this.load()
            );
            void this.load();
        }
    }

    ngOnDestroy(): void {
        this.unsubscribe?.();
    }

    async load(): Promise<void> {
        if (!this.isAvailable()) {
            return;
        }
        try {
            const list = await window.electron?.recordingScheduleGetList?.();
            this.schedules.set(list ?? []);
        } catch (error) {
            console.error('[RecordingSchedulesService] load failed:', error);
        }
    }

    async create(
        request: RecordingScheduleCreateRequest
    ): Promise<ElectronBridgeErrorResult> {
        if (!this.isAvailable()) {
            return { error: 'Scheduling is not available', success: false };
        }
        try {
            const result =
                (await window.electron?.recordingScheduleCreate?.(request)) ?? {
                    error: 'Scheduling bridge unavailable',
                    success: false,
                };
            if (result.success) {
                await this.load();
            }
            return result;
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : String(error),
                success: false,
            };
        }
    }

    async cancel(scheduleId: number): Promise<ElectronBridgeErrorResult> {
        if (!this.isAvailable()) {
            return { error: 'Scheduling is not available', success: false };
        }
        try {
            const result =
                (await window.electron?.recordingScheduleCancel?.(scheduleId)) ?? {
                    error: 'Scheduling bridge unavailable',
                    success: false,
                };
            if (result.success) {
                await this.load();
            }
            return result;
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : String(error),
                success: false,
            };
        }
    }
}
