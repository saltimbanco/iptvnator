import { computed, inject, Injectable, Injector, signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { selectAllPlaylistsMeta } from '@iptvnator/m3u-state';
import {
    liveChannelKey,
    liveChannelSearchProbes,
    rankLiveChannelCandidates,
} from '@iptvnator/playback/util';
import {
    extractPortalPlaylistId,
    getLiveCollectionPlaylistNavigation,
    type PortalProvider,
    type WorkspaceNavigationTarget,
} from '@iptvnator/portal/shared/util';
import { DatabaseService, SettingsStore, SortService } from '@iptvnator/services';
import {
    isM3uGlobalSearchResult,
    type GlobalSearchResult,
} from '@iptvnator/shared/interfaces';

/** Reloads of a failing live stream before other sources are tried. */
export const LIVE_FAILOVER_MAX_RETRIES = 3;
/** Time one attempt (a reload or a hop) gets to reach `playing`. */
export const LIVE_FAILOVER_ATTEMPT_MS = 10_000;
/**
 * Time a hop gets to mount the candidate's player: navigation plus the
 * target source's catalog hydration. Once the player reports loading, the
 * player's own {@link LIVE_FAILOVER_ATTEMPT_MS} takes over.
 */
export const LIVE_FAILOVER_ARRIVAL_MS = 30_000;
/**
 * How long a channel that failed in a source is left out of later
 * searches, so two sources failing in turn cannot hop back and forth.
 */
export const LIVE_FAILOVER_FAILURE_MEMORY_MS = 10 * 60_000;
const SEARCH_LIMIT = 500;
const PROVIDERS: readonly PortalProvider[] = ['xtreams', 'playlists', 'stalker'];

export type LiveChannelFailoverStatus =
    | { kind: 'retrying'; attempt: number; maxAttempts: number }
    | { kind: 'searching'; channelName: string }
    | {
          kind: 'hopping';
          channelName: string;
          sourceName: string;
          index: number;
          total: number;
      }
    | { kind: 'exhausted'; channelName: string };

interface HopCandidate {
    playlistId: string;
    sourceName: string;
    channelName: string;
    target: WorkspaceNavigationTarget;
}

interface Hop {
    /** The channel that failed, as its own source named it. */
    channelName: string;
    candidates: HopCandidate[];
    index: number;
}

/**
 * Cross-source live channel failover. The embedded MPV player reports its
 * live stream's progress here (see `EmbeddedMpvLiveFailover`): it retries a
 * failing stream itself and reports `failed` once its retries are spent.
 * This service then finds the same channel in the other sources by fuzzy
 * name and hops through them in source-list order — each hop is a real
 * navigation to that source's live view, which opens the channel — until
 * one plays. The hop then settles: the user stays in the working source and
 * browses its own categories and channels.
 *
 * Search uses the desktop SQLite catalog (Xtream and M3U sources).
 */
@Injectable({ providedIn: 'root' })
export class LiveChannelFailoverService {
    private readonly settingsStore = inject(SettingsStore);
    private readonly database = inject(DatabaseService);
    /** Store is read only when a search runs, see {@link findCandidates}. */
    private readonly injector = inject(Injector);
    private readonly sortService = inject(SortService);
    private readonly router = inject(Router);
    private readonly snackBar = inject(MatSnackBar);
    private readonly translate = inject(TranslateService);

    readonly enabled = computed(
        () => this.settingsStore.liveChannelFailover?.() === true
    );
    /** What the player shows while a retry or hop is in progress. */
    readonly status = signal<LiveChannelFailoverStatus | null>(null);

    private hop: Hop | null = null;
    private arrivalTimer: ReturnType<typeof setTimeout> | null = null;
    /** Retires a candidate search the user overtook. */
    private generation = 0;
    /** `playlistId + channel key` → when it failed. */
    private readonly recentFailures = new Map<string, number>();

    /** Whether `title` is the channel the current hop is trying. */
    isHopTarget(title: string): boolean {
        const candidate = this.currentCandidate();
        return (
            candidate !== null &&
            liveChannelKey(candidate.channelName) === liveChannelKey(title) &&
            this.currentPlaylistId() === candidate.playlistId
        );
    }

    /** A live playback started loading (not a retry). */
    reportLoading(title: string): void {
        if (this.isHopTarget(title)) {
            this.clearArrivalTimer();
            return;
        }
        // The user picked something else: whatever was in progress is over.
        this.reset();
    }

    reportRetrying(attempt: number): void {
        if (!this.hop) {
            this.status.set({
                kind: 'retrying',
                attempt,
                maxAttempts: LIVE_FAILOVER_MAX_RETRIES,
            });
        }
    }

    reportPlaying(title: string): void {
        const candidate = this.isHopTarget(title)
            ? this.currentCandidate()
            : null;
        if (candidate) {
            this.notify('EMBEDDED_MPV.PLAYER.FAILOVER_SWITCHED', {
                source: candidate.sourceName,
                channel: candidate.channelName,
            });
        }
        this.reset();
    }

    /** The player gave up on `title`: its retries, or this hop, failed. */
    async reportFailed(title: string): Promise<void> {
        const playlistId = this.currentPlaylistId();
        if (playlistId) {
            this.recentFailures.set(failureKey(playlistId, title), Date.now());
        }
        if (this.hop && this.isHopTarget(title)) {
            this.tryCandidate(this.hop.index + 1);
            return;
        }
        this.reset();
        if (!playlistId) {
            return;
        }
        const generation = ++this.generation;
        this.status.set({ kind: 'searching', channelName: title });
        const candidates = await this.findCandidates(title, playlistId);
        if (generation !== this.generation) {
            return;
        }
        this.hop = { channelName: title, candidates, index: -1 };
        this.tryCandidate(0);
    }

    private tryCandidate(index: number): void {
        this.clearArrivalTimer();
        const hop = this.hop;
        if (!hop) {
            return;
        }
        const candidate = hop.candidates[index];
        if (!candidate) {
            this.reset();
            this.status.set({
                kind: 'exhausted',
                channelName: hop.channelName,
            });
            this.notify('EMBEDDED_MPV.PLAYER.FAILOVER_EXHAUSTED', {
                channel: hop.channelName,
            });
            return;
        }
        hop.index = index;
        this.status.set({
            kind: 'hopping',
            channelName: candidate.channelName,
            sourceName: candidate.sourceName,
            index: index + 1,
            total: hop.candidates.length,
        });
        this.arrivalTimer = setTimeout(() => {
            this.arrivalTimer = null;
            if (this.currentPlaylistId() === candidate.playlistId) {
                this.tryCandidate(index + 1);
            } else {
                // The user navigated away from the hop.
                this.reset();
            }
        }, LIVE_FAILOVER_ARRIVAL_MS);
        void this.router.navigate(candidate.target.link, {
            state: candidate.target.state,
        });
    }

    private async findCandidates(
        title: string,
        failingPlaylistId: string
    ): Promise<HopCandidate[]> {
        const options = await firstValueFrom(this.sortService.getSortOptions());
        // Resolved lazily: every embedded player injects this service, and
        // only an actual failover needs the source list.
        const playlists = await firstValueFrom(
            this.injector.get(Store).select(selectAllPlaylistsMeta)
        );
        const sources = this.sortService.sortPlaylists(playlists, options);
        const names = new Map(sources.map((p) => [p._id, p.title]));
        const order = sources.map((playlist) => playlist._id);
        for (const probe of liveChannelSearchProbes(title)) {
            const results = (await this.search(probe)).filter(
                (result) => !this.failedRecently(result.playlist_id, result.title)
            );
            const ranked = rankLiveChannelCandidates(
                title,
                results.map((result) => ({
                    playlistId: result.playlist_id,
                    title: result.title,
                    result,
                })),
                order,
                failingPlaylistId
            );
            const candidates: HopCandidate[] = [];
            for (const { playlistId, title: channelName, result } of ranked) {
                const target = navigationTarget(result);
                if (target) {
                    candidates.push({
                        playlistId,
                        channelName,
                        sourceName: names.get(playlistId) ?? '',
                        target,
                    });
                }
            }
            if (candidates.length > 0) {
                return candidates;
            }
        }
        return [];
    }

    private async search(probe: string): Promise<GlobalSearchResult[]> {
        try {
            return (
                (await this.database.globalSearchContent(
                    probe,
                    ['live'],
                    true,
                    undefined,
                    { limit: SEARCH_LIMIT }
                )) ?? []
            );
        } catch {
            return [];
        }
    }

    private failedRecently(playlistId: string, title: string): boolean {
        const failedAt = this.recentFailures.get(failureKey(playlistId, title));
        return (
            failedAt !== undefined &&
            Date.now() - failedAt < LIVE_FAILOVER_FAILURE_MEMORY_MS
        );
    }

    private currentCandidate(): HopCandidate | null {
        return this.hop?.candidates[this.hop.index] ?? null;
    }

    private currentPlaylistId(): string | null {
        const url = this.router.url;
        for (const provider of PROVIDERS) {
            const id = extractPortalPlaylistId(url, provider);
            if (id) {
                return decodeURIComponent(id);
            }
        }
        return null;
    }

    private reset(): void {
        this.generation += 1;
        this.clearArrivalTimer();
        this.hop = null;
        this.status.set(null);
    }

    private clearArrivalTimer(): void {
        if (this.arrivalTimer !== null) {
            clearTimeout(this.arrivalTimer);
            this.arrivalTimer = null;
        }
    }

    private notify(key: string, params: object): void {
        this.snackBar.open(this.translate.instant(key, params), undefined, {
            duration: 5000,
        });
    }
}

function failureKey(playlistId: string, title: string): string {
    return `${playlistId}\u0000${liveChannelKey(title)}`;
}

function navigationTarget(
    result: GlobalSearchResult
): WorkspaceNavigationTarget | null {
    return isM3uGlobalSearchResult(result)
        ? getLiveCollectionPlaylistNavigation({
              sourceType: 'm3u',
              playlistId: result.playlist_id,
              name: result.title,
              streamUrl: result.stream_url,
          })
        : getLiveCollectionPlaylistNavigation({
              sourceType: 'xtream',
              playlistId: result.playlist_id,
              name: result.title,
              xtreamId: result.xtream_id,
              logo: result.poster_url,
          });
}
