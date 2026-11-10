import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import type { ElectronBridgeErrorResult } from '@iptvnator/shared/interfaces';
import {
    ScheduleRecordingDialogComponent,
    type ScheduleRecordingDialogData,
    type ScheduleRecordingTarget,
} from './schedule-recording-dialog.component';

const TEST_TRANSLATIONS = {
    RECORDING_SCHEDULE: {
        TITLE: 'Schedule recording · {{channel}}',
        HINT: 'Records in the background.',
        DATE: 'Date',
        START: 'Start',
        END: 'End',
        SAVE: 'Schedule',
        DONE: 'Done',
        PREPARING: 'Preparing the stream…',
        SAVED: 'Scheduled for {{window}}.',
        ERROR_TIMES: 'Pick a time.',
        ERROR_ORDER: 'The end must follow the start.',
        ERROR_PAST: 'Pick a future time.',
        ERROR_SAVE: 'Could not schedule.',
        ERROR_RESOLVE: 'This stream could not be resolved.',
    },
    COMMON: { CANCEL: 'Cancel' },
};

const TARGET: ScheduleRecordingTarget = {
    playback: { streamUrl: 'https://portal.example/live/1', title: 'News' },
    metadata: { channelName: 'News' },
};

async function setup(
    overrides: Partial<ScheduleRecordingDialogData> = {}
): Promise<{
    component: ScheduleRecordingDialogComponent;
    submit: jest.Mock;
    close: jest.Mock;
}> {
    const submit = jest.fn(
        async (): Promise<ElectronBridgeErrorResult> => ({ success: true })
    );
    const close = jest.fn();
    const data: ScheduleRecordingDialogData = {
        channelName: 'News',
        initial: { date: '2099-01-01', startTime: '20:00', endTime: '21:00' },
        submit,
        ...overrides,
    };

    await TestBed.configureTestingModule({
        imports: [
            ScheduleRecordingDialogComponent,
            NoopAnimationsModule,
            TranslateModule.forRoot(),
        ],
        providers: [
            { provide: MAT_DIALOG_DATA, useValue: data },
            { provide: MatDialogRef, useValue: { close } },
        ],
    }).compileComponents();

    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', TEST_TRANSLATIONS);
    translate.use('en');

    const fixture = TestBed.createComponent(ScheduleRecordingDialogComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { component: fixture.componentInstance, submit, close };
}

describe('ScheduleRecordingDialogComponent', () => {
    it('submits the chosen window and keeps a confirmation on screen', async () => {
        const { component, submit } = await setup();
        expect(component.preparing()).toBe(false);

        await component.submit();

        expect(submit).toHaveBeenCalledWith(
            {
                startAt: new Date('2099-01-01T20:00:00').toISOString(),
                endAt: new Date('2099-01-01T21:00:00').toISOString(),
            },
            undefined
        );
        expect(component.saved()).toBe(true);
        expect(component.savedWindow()).toContain('2099-01-01');
    });

    it('resolves the stream while the dialog is already open', async () => {
        let release!: (target: ScheduleRecordingTarget | null) => void;
        const resolve = jest.fn(
            () =>
                new Promise<ScheduleRecordingTarget | null>((done) => {
                    release = done;
                })
        );
        const fixturePromise = setup({ resolve });
        const { component, submit } = await fixturePromise;

        expect(component.preparing()).toBe(true);
        release(TARGET);
        await Promise.resolve();
        await Promise.resolve();

        expect(component.preparing()).toBe(false);
        expect(component.prepareFailed()).toBe(false);

        await component.submit();
        expect(submit).toHaveBeenCalledWith(expect.any(Object), TARGET);
    });

    it('refuses to schedule when the stream cannot be resolved', async () => {
        const { component, submit } = await setup({
            resolve: async () => null,
        });

        expect(component.prepareFailed()).toBe(true);
        await component.submit();

        expect(submit).not.toHaveBeenCalled();
        expect(component.saved()).toBe(false);
    });

    it('closes with the saved state after the confirmation', async () => {
        const { component, close } = await setup();
        await component.submit();

        component.close();

        expect(close).toHaveBeenCalledWith(true);
    });
});
