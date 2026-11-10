import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import type { RecordingScheduleItem } from '@iptvnator/shared/interfaces';
import { RecordingScheduleListComponent } from './recording-schedule-list.component';

const TEST_TRANSLATIONS = {
    RECORDING_SCHEDULE: {
        LIST_TITLE: 'Scheduled recordings',
        CANCEL: 'Cancel scheduled recording',
    },
};

function schedule(
    id: number,
    overrides: Partial<RecordingScheduleItem> = {}
): RecordingScheduleItem {
    return {
        id,
        channelName: `Channel ${id}`,
        startAt: '2026-08-15T19:00:00Z',
        endAt: '2026-08-15T20:00:00Z',
        status: 'pending',
        ...overrides,
    };
}

describe('RecordingScheduleListComponent', () => {
    let fixture: ComponentFixture<RecordingScheduleListComponent>;

    function render(
        schedules: readonly RecordingScheduleItem[],
        pendingIds: ReadonlySet<number> = new Set()
    ): void {
        fixture.componentRef.setInput('schedules', schedules);
        fixture.componentRef.setInput('pendingIds', pendingIds);
        fixture.detectChanges();
    }

    function row(id: number): HTMLElement {
        const element = fixture.nativeElement.querySelector(
            `[data-test-id="recording-schedule-${id}"]`
        );
        expect(element).not.toBeNull();
        return element;
    }

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [
                RecordingScheduleListComponent,
                NoopAnimationsModule,
                TranslateModule.forRoot(),
            ],
        }).compileComponents();

        const translate = TestBed.inject(TranslateService);
        translate.setTranslation('en', TEST_TRANSLATIONS);
        translate.use('en');
        fixture = TestBed.createComponent(RecordingScheduleListComponent);
    });

    afterEach(() => fixture.destroy());

    it('renders nothing while no schedule is pending', () => {
        render([]);

        expect(
            fixture.nativeElement.querySelector(
                '[data-test-id="recording-schedule-list"]'
            )
        ).toBeNull();
        expect(fixture.nativeElement.querySelector('section')).toBeNull();
    });

    it('lists every pending schedule with its channel, window and playlist', () => {
        render([
            schedule(1, {
                channelName: 'Portal news',
                playlistName: 'Alpha source',
                channelLogoUrl: 'https://cdn.example/logo.png',
            }),
            schedule(2, { channelName: 'Second channel' }),
        ]);

        const section = fixture.nativeElement.querySelector(
            '[data-test-id="recording-schedule-list"]'
        ) as HTMLElement;
        expect(
            section.querySelector('.app-count-badge')?.textContent?.trim()
        ).toBe('2');
        expect(
            section.querySelector('h2')?.textContent?.replace(/\s+/g, ' ')
        ).toContain('Scheduled recordings');

        expect(
            row(1)
                .querySelector('.recording-schedules__channel')
                ?.textContent?.trim()
        ).toBe('Portal news');
        const times = row(1)
            .querySelector('.recording-schedules__times')
            ?.textContent?.replace(/\s+/g, ' ')
            .trim();
        expect(times).toContain('Alpha source');
        expect(times).toMatch(/\d{2}:\d{2}/);
        expect(row(2).textContent).toContain('Second channel');
        expect(row(2).querySelector('img')).toBeNull();
        expect(
            row(2).querySelector('.recording-schedules__logo mat-icon')
                ?.textContent?.trim()
        ).toBe('schedule');
    });

    it('emits the schedule the cancel button belongs to', () => {
        const requested: RecordingScheduleItem[] = [];
        fixture.componentInstance.cancelRequested.subscribe((item) =>
            requested.push(item)
        );
        const first = schedule(3);
        const second = schedule(4);
        render([first, second]);

        row(4)
            .querySelector<HTMLButtonElement>(
                '[data-test-action="cancel-schedule-4"]'
            )
            ?.click();

        expect(requested).toEqual([second]);
        expect(requested[0]).toBe(second);
        expect(requested).not.toContain(first);
    });

    it('disables and suppresses a row whose cancel is already in flight', () => {
        const requested = jest.fn();
        fixture.componentInstance.cancelRequested.subscribe(requested);
        render([schedule(5), schedule(6)], new Set([5]));

        const pendingRow = row(5);
        expect(pendingRow.getAttribute('aria-busy')).toBe('true');
        const pendingButton = pendingRow.querySelector<HTMLButtonElement>(
            '[data-test-action="cancel-schedule-5"]'
        );
        expect(pendingButton?.disabled).toBe(true);

        fixture.componentInstance.cancel(schedule(5));
        expect(requested).not.toHaveBeenCalled();

        const readyButton = row(6).querySelector<HTMLButtonElement>(
            '[data-test-action="cancel-schedule-6"]'
        );
        expect(readyButton?.disabled).toBe(false);
        readyButton?.click();
        expect(requested).toHaveBeenCalledTimes(1);
        expect(requested.mock.calls[0][0]).toMatchObject({ id: 6 });
        expect(row(6).getAttribute('aria-busy')).toBeNull();
    });

    it('labels the cancel control for screen readers', () => {
        render([schedule(7)]);

        expect(
            row(7)
                .querySelector<HTMLButtonElement>(
                    '[data-test-action="cancel-schedule-7"]'
                )
                ?.getAttribute('aria-label')
        ).toBe('Cancel scheduled recording');
    });
});
