import type { EpgProgram } from '@iptvnator/shared/interfaces';
import type { EpgTimelineEmptyReason } from './epg-timeline-empty-state.component';
import { hasProgramsForDateKey } from './epg-timeline.utils';

export type TimelineRenderState =
    | 'loading'
    | 'ribbon'
    | EpgTimelineEmptyReason;

/**
 * What the timeline shows for the loaded guide: the ribbon, a reason it has
 * nothing to draw, or the loading skeleton. Pure so the view only has to
 * read its signals.
 */
export function timelineRenderState(
    loading: boolean,
    emptyReason: EpgTimelineEmptyReason,
    programs: EpgProgram[],
    dayKey: string,
    offsetMinutes: number
): TimelineRenderState {
    if (loading) {
        return 'loading';
    }
    if (emptyReason !== 'none') {
        return emptyReason;
    }
    if (programs.length === 0) {
        return 'channel-unmapped';
    }
    if (!hasProgramsForDateKey(programs, dayKey, offsetMinutes)) {
        return 'empty-day';
    }
    return 'ribbon';
}
