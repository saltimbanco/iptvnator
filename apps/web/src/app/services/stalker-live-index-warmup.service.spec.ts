import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Store } from '@ngrx/store';
import { StalkerItvCacheService } from '@iptvnator/portal/stalker/data-access';
import { DatabaseService, SettingsStore } from '@iptvnator/services';
import type { PlaylistMeta } from '@iptvnator/shared/interfaces';
import { of } from 'rxjs';
import { StalkerLiveIndexWarmupService } from './stalker-live-index-warmup.service';

function portal(id: string): PlaylistMeta {
    return {
        _id: id,
        title: id,
        portalUrl: `http://${id}/portal.php`,
        macAddress: '00:1A:79:00:00:01',
        count: 10,
    } as PlaylistMeta;
}

describe('StalkerLiveIndexWarmupService', () => {
    let playlists: PlaylistMeta[];
    let enabled: WritableSignal<boolean>;
    let indexed: Set<string>;
    let ensureLoaded: jest.Mock;

    async function start(): Promise<StalkerLiveIndexWarmupService> {
        const service = TestBed.inject(StalkerLiveIndexWarmupService);
        service.start();
        // Let the playlist read and every `ensureLoaded` settle.
        for (let tick = 0; tick < 40; tick++) {
            await Promise.resolve();
        }
        return service;
    }

    beforeEach(() => {
        playlists = [portal('portal-a'), portal('portal-b')];
        enabled = signal(true);
        indexed = new Set();
        ensureLoaded = jest.fn().mockResolvedValue(undefined);
        TestBed.configureTestingModule({
            providers: [
                {
                    provide: Store,
                    useValue: { select: () => of(playlists) },
                },
                {
                    provide: SettingsStore,
                    useValue: {
                        liveChannelFailover: enabled.asReadonly(),
                        loadSettings: jest.fn().mockResolvedValue(undefined),
                    },
                },
                {
                    provide: DatabaseService,
                    useValue: {
                        getAppState: jest.fn((key: string) =>
                            Promise.resolve(
                                indexed.has(key) ? '{"channels":[]}' : null
                            )
                        ),
                    },
                },
                {
                    provide: StalkerItvCacheService,
                    useValue: { ensureLoaded },
                },
            ],
        });
    });

    it('loads the live list of every portal that has no index yet', async () => {
        await start();

        expect(ensureLoaded).toHaveBeenCalledTimes(2);
        expect(ensureLoaded).toHaveBeenCalledWith(playlists[0]);
        expect(ensureLoaded).toHaveBeenCalledWith(playlists[1]);
    });

    it('skips a portal whose list was already indexed', async () => {
        indexed.add('stalker-live-channel-index:portal-a');

        await start();

        expect(ensureLoaded).toHaveBeenCalledTimes(1);
        expect(ensureLoaded).toHaveBeenCalledWith(playlists[1]);
    });

    it('does nothing while the failover setting is off', async () => {
        enabled.set(false);

        await start();

        expect(ensureLoaded).not.toHaveBeenCalled();
    });

    it('keeps warming the remaining portals after one fails', async () => {
        ensureLoaded.mockRejectedValueOnce(new Error('portal offline'));

        await start();

        expect(ensureLoaded).toHaveBeenCalledTimes(2);
    });

    it('warms only once per app run', async () => {
        const service = await start();
        service.start();

        expect(ensureLoaded).toHaveBeenCalledTimes(2);
    });
});
