/**
 * One rule set for the window a schedule may be created or moved to, shared
 * by both IPC handlers so a reschedule cannot accept a window a create would
 * reject (or the other way around).
 */
export interface ScheduleWindowInput {
    readonly startAt?: unknown;
    readonly endAt?: unknown;
}

export type ScheduleWindowResult =
    | { readonly window: { readonly startAt: string; readonly endAt: string } }
    | { readonly error: string };

export function resolveScheduleWindow(
    input: ScheduleWindowInput | null | undefined,
    now: number = Date.now()
): ScheduleWindowResult {
    if (typeof input?.startAt !== 'string' || typeof input?.endAt !== 'string') {
        return { error: 'Pick a start and an end time.' };
    }
    const startMs = Date.parse(input.startAt);
    const endMs = Date.parse(input.endAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return { error: 'Pick a start and an end time.' };
    }
    if (endMs <= startMs) {
        return { error: 'The end time must be after the start time.' };
    }
    if (endMs <= now) {
        return { error: 'The scheduled time has already passed.' };
    }
    return { window: { startAt: input.startAt, endAt: input.endAt } };
}
