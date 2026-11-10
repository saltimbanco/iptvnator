import { resolveScheduleWindow } from './recording-schedule-window';

const NOW = Date.parse('2026-11-10T12:00:00Z');

describe('resolveScheduleWindow', () => {
    it('accepts a window that ends in the future', () => {
        const result = resolveScheduleWindow(
            {
                startAt: '2026-11-10T18:00:00.000Z',
                endAt: '2026-11-10T19:00:00.000Z',
            },
            NOW
        );

        expect(result).toEqual({
            window: {
                startAt: '2026-11-10T18:00:00.000Z',
                endAt: '2026-11-10T19:00:00.000Z',
            },
        });
    });

    it('rejects missing or non-string instants', () => {
        expect(resolveScheduleWindow(null, NOW)).toEqual({
            error: 'Pick a start and an end time.',
        });
        expect(
            resolveScheduleWindow(
                { startAt: 42, endAt: '2026-11-10T19:00:00.000Z' },
                NOW
            )
        ).toEqual({ error: 'Pick a start and an end time.' });
        expect(
            resolveScheduleWindow(
                { startAt: 'not-a-date', endAt: '2026-11-10T19:00:00.000Z' },
                NOW
            )
        ).toEqual({ error: 'Pick a start and an end time.' });
    });

    it('rejects an end that is not after the start', () => {
        expect(
            resolveScheduleWindow(
                {
                    startAt: '2026-11-10T19:00:00.000Z',
                    endAt: '2026-11-10T19:00:00.000Z',
                },
                NOW
            )
        ).toEqual({ error: 'The end time must be after the start time.' });
    });

    it('rejects a window that has already passed', () => {
        expect(
            resolveScheduleWindow(
                {
                    startAt: '2026-11-10T10:00:00.000Z',
                    endAt: '2026-11-10T11:00:00.000Z',
                },
                NOW
            )
        ).toEqual({ error: 'The scheduled time has already passed.' });
    });
});
