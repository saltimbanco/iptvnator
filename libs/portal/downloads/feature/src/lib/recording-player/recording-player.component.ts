import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import {
    RecordingsService,
    RuntimeCapabilitiesService,
    SettingsStore,
} from '@iptvnator/services';
import {
    type ResolvedPortalPlayback,
    VideoPlayer,
} from '@iptvnator/shared/interfaces';
import { PortalInlinePlayerComponent } from '@iptvnator/ui/playback';
import { map } from 'rxjs';
import { recordingPlaybackSource } from '../recording-playback.util';

/**
 * Plays one live-TV recording inside the app
 * (`/workspace/downloads/recording-player/:recordingId`).
 *
 * The recording manager used to hand finished files to the OS player; this
 * page runs them through the same inline player as portal content, so
 * playback, seeking and fullscreen stay inside IPTVnator.
 */
@Component({
    selector: 'app-recording-player',
    templateUrl: './recording-player.component.html',
    styleUrl: './recording-player.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        MatButtonModule,
        MatIcon,
        PortalInlinePlayerComponent,
        TranslatePipe,
    ],
})
export class RecordingPlayerComponent {
    private readonly route = inject(ActivatedRoute);
    private readonly router = inject(Router);
    private readonly recordings = inject(RecordingsService);
    private readonly settingsStore = inject(SettingsStore);
    private readonly runtime = inject(RuntimeCapabilitiesService);

    readonly recordingId = toSignal(
        this.route.paramMap.pipe(
            map((params) => Number(params.get('recordingId')))
        ),
        { initialValue: Number(this.route.snapshot.params['recordingId']) }
    );
    readonly item = computed(
        () =>
            this.recordings
                .recordings()
                .find((row) => row.id === this.recordingId()) ?? null
    );
    readonly title = computed(() => {
        const item = this.item();
        return item ? item.programTitle?.trim() || item.channelName : '';
    });
    /**
     * Recordings are MPEG-TS, which the web engines cannot demux. Prefer the
     * embedded MPV engine whenever the runtime has it, so the default player
     * setting does not turn every recording into a playback error.
     */
    readonly player = computed<VideoPlayer>(() =>
        this.runtime.supportsEmbeddedMpv
            ? VideoPlayer.EmbeddedMpv
            : (this.settingsStore.player?.() ?? VideoPlayer.VideoJs)
    );
    readonly isPlayable = computed(() => {
        const item = this.item();
        return (
            !!item?.filePath &&
            (item.status === 'completed' || item.status === 'interrupted') &&
            item.fileAvailability !== 'missing'
        );
    });
    readonly playback = computed<ResolvedPortalPlayback | null>(() => {
        const item = this.item();
        if (!this.isPlayable() || !item?.filePath) {
            return null;
        }
        return {
            streamUrl: recordingPlaybackSource(item.filePath, this.player()),
            title: this.title() || item.filePath,
            thumbnail: item.channelLogoUrl ?? null,
            isLive: false,
        };
    });

    constructor() {
        void this.recordings.loadRecordings();
        // Removed elsewhere, a bogus id, or an authoritative reload without
        // this row → leave the player instead of showing an empty stage.
        effect(() => {
            if (
                this.recordings.hasLoadedRecordings() &&
                this.recordings.hasAuthoritativeRecordingList() &&
                !this.recordings.isLoadingRecordings() &&
                this.item() === null
            ) {
                this.goBack();
            }
        });
    }

    goBack(): void {
        void this.router.navigateByUrl('/workspace/downloads?filter=recording');
    }
}
