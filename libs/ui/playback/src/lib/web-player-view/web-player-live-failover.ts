import {
    DestroyRef,
    effect,
    inject,
    Signal,
    untracked,
} from '@angular/core';
import {
    LIVE_FAILOVER_ATTEMPT_MS,
    LIVE_FAILOVER_MAX_RETRIES,
    LIVE_FAILOVER_STALL_MS,
    LiveChannelFailoverService,
} from '@iptvnator/playback/data-access';
import type { PlaybackDiagnostic } from '@iptvnator/playback/util';
import type { ResolvedPortalPlayback } from '@iptvnator/shared/interfaces';

export interface WebPlayerLiveFailoverDeps {
    /** Router to the cross-source hop, shared with the embedded player. */
    failover: LiveChannelFailoverService;
    /** The playback the rendered engine is showing. */
    playback: Signal<ResolvedPortalPlayback | null>;
    /** The view's logical session; a different stream is a new budget. */
    sessionKey: Signal<string>;
    isLive: Signal<boolean>;
    /** A built-in web engine is mounted — embedded MPV retries itself. */
    active: Signal<boolean>;
    /** Remounts the same playback in a fresh engine. */
    retry: () => void;
}

/**
 * Live stream retries for the built-in web players (`videojs`, `html5`,
 * `artplayer`), while the Settings → Live channel failover toggle is on.
 *
 * Mirrors `EmbeddedMpvLiveFailover`: each attempt gets
 * {@link LIVE_FAILOVER_ATTEMPT_MS} to report that it is playing, and a
 * playback diagnostic — the web engines' only fatal signal — spends an
 * attempt. Three spent attempts hand the channel to
 * {@link LiveChannelFailoverService}, which hops to other sources. A hop's
 * candidate gets a single attempt.
 *
 * Must be created in an injection context (a component field).
 */
export class WebPlayerLiveFailover {
    /** Retries spent on the current stream. */
    private retries = 0;
    /** The current attempt's outcome, so each is spent once. */
    private phase: 'pending' | 'playing' | 'failed' | 'idle' = 'idle';
    private watchdog: ReturnType<typeof setTimeout> | null = null;
    /** Fires when a stream that already played stops making progress. */
    private stallWatchdog: ReturnType<typeof setTimeout> | null = null;
    private active = false;
    private title = '';
    /** Session key + stream URL of the attempt this budget belongs to. */
    private attemptKey = '';

    constructor(private readonly deps: WebPlayerLiveFailoverDeps) {
        effect(() => {
            const playback = deps.playback();
            const key = `${deps.sessionKey()}\u0000${playback?.streamUrl ?? ''}`;
            const active =
                deps.failover.enabled() &&
                deps.isLive() &&
                deps.active() &&
                playback !== null;
            untracked(() => {
                this.active = active;
                this.title = playback?.title ?? '';
                if (!active) {
                    this.attemptKey = '';
                    this.stop();
                    return;
                }
                if (key !== this.attemptKey) {
                    this.attemptKey = key;
                    this.restart();
                }
            });
        });

        inject(DestroyRef).onDestroy(() => this.stop());
    }

    /**
     * A new playback, or the user's own Retry (`manual`): a fresh retry
     * budget. A manual retry also clears the failover's memory of earlier
     * failures, so every source is tested again.
     */
    restart(manual = false): void {
        if (!this.active) {
            return;
        }
        this.retries = 0;
        if (manual) {
            this.deps.failover.reportLoading(this.title, {
                forgetFailures: true,
            });
        } else {
            this.deps.failover.reportLoading(this.title);
        }
        this.startAttempt();
    }

    /**
     * A playback diagnostic that survived the live format fallback. Returns
     * true when this adapter owns the outcome, so the view keeps its manual
     * recovery card out of the way of the automatic retries.
     */
    onIssue(_issue: PlaybackDiagnostic): boolean {
        if (
            !this.active ||
            (this.phase !== 'pending' && this.phase !== 'playing')
        ) {
            return false;
        }
        this.fail();
        return true;
    }

    /** The engine reported that the stream plays. */
    onStarted(): void {
        if (!this.active) {
            return;
        }
        this.clearWatchdog();
        this.phase = 'playing';
        this.retries = 0;
        this.deps.failover.reportPlaying(this.title);
        this.armStallWatchdog();
    }

    /**
     * The engine advanced its position. A live stream whose position stops
     * moving is dead even when the engine never reports an error — the web
     * engines have no socket timeout, so this is what notices a frozen
     * picture after {@link LIVE_FAILOVER_STALL_MS}.
     */
    onProgress(): void {
        if (!this.active || this.phase !== 'playing') {
            return;
        }
        this.armStallWatchdog();
    }

    private fail(): void {
        this.clearWatchdog();
        this.phase = 'failed';
        if (
            this.deps.failover.isHopTarget(this.title) ||
            this.retries >= LIVE_FAILOVER_MAX_RETRIES
        ) {
            void this.deps.failover.reportFailed(this.title);
            return;
        }
        this.retries += 1;
        this.deps.failover.reportRetrying(this.retries);
        this.startAttempt();
        this.deps.retry();
    }

    private armStallWatchdog(): void {
        this.clearWatchdog();
        this.stallWatchdog = setTimeout(() => {
            this.stallWatchdog = null;
            if (this.phase === 'playing') {
                this.fail();
            }
        }, LIVE_FAILOVER_STALL_MS);
    }

    private startAttempt(): void {
        this.clearWatchdog();
        this.phase = 'pending';
        this.watchdog = setTimeout(() => {
            this.watchdog = null;
            if (this.phase === 'pending') {
                this.fail();
            }
        }, LIVE_FAILOVER_ATTEMPT_MS);
    }

    private stop(): void {
        this.clearWatchdog();
        this.phase = 'idle';
    }

    private clearWatchdog(): void {
        if (this.watchdog !== null) {
            clearTimeout(this.watchdog);
            this.watchdog = null;
        }
        if (this.stallWatchdog !== null) {
            clearTimeout(this.stallWatchdog);
            this.stallWatchdog = null;
        }
    }
}
