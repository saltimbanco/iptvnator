import { Component, signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import type { LiveChannelFailoverStatus } from '@iptvnator/playback/data-access';
import { LiveChannelFailoverService } from '@iptvnator/playback/data-access';
import { LiveFailoverStatusComponent } from './live-failover-status.component';

@Component({
    imports: [LiveFailoverStatusComponent],
    template: `<app-live-failover-status [enabled]="enabled()" />`,
})
class HostComponent {
    readonly enabled = signal(true);
}

describe('LiveFailoverStatusComponent', () => {
    let fixture: ComponentFixture<HostComponent>;
    let status: WritableSignal<LiveChannelFailoverStatus | null>;
    let featureEnabled: WritableSignal<boolean>;

    function render(): string {
        fixture.detectChanges();
        return (
            fixture.nativeElement.querySelector('.live-failover-status__text')
                ?.textContent ?? ''
        );
    }

    function translations(): void {
        const translate = TestBed.inject(TranslateService);
        translate.setTranslation('en', {
            EMBEDDED_MPV: {
                PLAYER: {
                    FAILOVER_RETRYING:
                        'Stream failed. Retrying ({{attempt}}/{{maxAttempts}})…',
                    FAILOVER_SEARCHING:
                        'Looking for “{{channel}}” in your other sources…',
                    FAILOVER_HOPPING:
                        'Trying source {{index}}/{{total}}: {{source}} — {{channel}}',
                    FAILOVER_EXHAUSTED:
                        'No working source found for “{{channel}}”',
                },
            },
        });
        translate.use('en');
    }

    describe('with live failover available', () => {
        beforeEach(async () => {
            status = signal<LiveChannelFailoverStatus | null>(null);
            featureEnabled = signal(true);
            await TestBed.configureTestingModule({
                imports: [HostComponent, TranslateModule.forRoot()],
                providers: [
                    {
                        provide: LiveChannelFailoverService,
                        useValue: {
                            enabled: featureEnabled.asReadonly(),
                            status,
                        },
                    },
                ],
            }).compileComponents();
            translations();
            fixture = TestBed.createComponent(HostComponent);
        });

        it('shows the retry counter while a live stream is re-tried', () => {
            status.set({ kind: 'retrying', attempt: 2, maxAttempts: 3 });
            expect(render()).toContain('Retrying (2/3)');
        });

        it('shows the source hop with its position in the candidate list', () => {
            status.set({
                kind: 'hopping',
                channelName: 'ERT 1',
                sourceName: 'Backup',
                index: 2,
                total: 3,
            });
            expect(render()).toBe('Trying source 2/3: Backup — ERT 1');
        });

        it('names the channel while searching and when nothing played', () => {
            status.set({ kind: 'searching', channelName: 'ERT 1' });
            expect(render()).toContain('ERT 1');

            status.set({ kind: 'exhausted', channelName: 'ERT 1' });
            expect(render()).toContain('No working source found');
        });

        it('renders nothing without a status, with the feature off, or for a native view', () => {
            expect(render()).toBe('');

            status.set({ kind: 'searching', channelName: 'ERT 1' });
            featureEnabled.set(false);
            expect(render()).toBe('');

            featureEnabled.set(true);
            fixture.componentInstance.enabled.set(false);
            expect(render()).toBe('');
        });
    });

    describe('without a failover service', () => {
        beforeEach(async () => {
            await TestBed.configureTestingModule({
                imports: [HostComponent, TranslateModule.forRoot()],
            }).compileComponents();
            translations();
            fixture = TestBed.createComponent(HostComponent);
        });

        it('renders nothing instead of failing to mount', () => {
            expect(render()).toBe('');
        });
    });
});
