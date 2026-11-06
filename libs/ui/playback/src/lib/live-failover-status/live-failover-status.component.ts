import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    input,
    ViewEncapsulation,
} from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { LiveChannelFailoverService } from '@iptvnator/playback/data-access';
import { injectTranslationTick } from '@iptvnator/services';

/**
 * Live failover progress over a built-in web engine: the retry counter while
 * a stream is re-tried and the source hop while another source is tried.
 *
 * The service used to announce only its outcome through a snackbar, which
 * left the retry and the hop invisible for up to tens of seconds. The engine
 * itself keeps showing the failed stream's last frame, so this overlay is the
 * only sign that the playability test is running.
 *
 * Mounted by the player view's fullscreen-stage host
 * (`FullscreenChannelPanelComponent`), which is a `display: contents` sibling
 * of every engine and therefore needs no extra layout. `enabled` is the
 * host's "DOM overlays are visible" flag: it is false for the native-view
 * Embedded MPV engine, which paints above the page and reports the same
 * status in its own status line.
 *
 * The service is injected optionally: hosts without live failover (a bare
 * player surface, or a spec rendering the stage on its own) simply show
 * nothing.
 */
@Component({
    selector: 'app-live-failover-status',
    templateUrl: './live-failover-status.component.html',
    styleUrl: './live-failover-status.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    encapsulation: ViewEncapsulation.None,
    host: { class: 'live-failover-status-host' },
})
export class LiveFailoverStatusComponent {
    /** False while the engine paints above the DOM. */
    readonly enabled = input(true);

    private readonly failover = inject(LiveChannelFailoverService, {
        optional: true,
    });
    private readonly translate = inject(TranslateService);
    /** `translate.instant` is invisible to the signal graph. */
    private readonly translationsTick = injectTranslationTick();

    readonly label = computed(() => {
        this.translationsTick();
        const failover = this.failover;
        if (!this.enabled() || !failover?.enabled()) {
            return '';
        }
        const status = failover.status();
        if (!status) {
            return '';
        }
        switch (status.kind) {
            case 'retrying':
                return this.translate.instant(
                    'EMBEDDED_MPV.PLAYER.FAILOVER_RETRYING',
                    status
                );
            case 'searching':
                return this.translate.instant(
                    'EMBEDDED_MPV.PLAYER.FAILOVER_SEARCHING',
                    { channel: status.channelName }
                );
            case 'hopping':
                return this.translate.instant(
                    'EMBEDDED_MPV.PLAYER.FAILOVER_HOPPING',
                    {
                        index: status.index,
                        total: status.total,
                        source: status.sourceName,
                        channel: status.channelName,
                    }
                );
            case 'exhausted':
                return this.translate.instant(
                    'EMBEDDED_MPV.PLAYER.FAILOVER_EXHAUSTED',
                    { channel: status.channelName }
                );
        }
    });
}
