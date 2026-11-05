import { TestBed } from '@angular/core/testing';
import { DataService, SettingsStore } from '@iptvnator/services';
import { STALKER_REQUEST, type Playlist } from '@iptvnator/shared/interfaces';
import { StalkerContentSeedService } from './stalker-content-seed.service';
import { StalkerItvCacheService } from './stalker-itv-cache.service';
import { StalkerPortalRepairService } from './stalker-portal-repair.service';
import { StalkerSessionService } from './stalker-session.service';

describe('StalkerContentSeedService', () => {
    let dataService: { sendIpcEvent: jest.Mock };
    let session: { ensureToken: jest.Mock };
    let itvCache: { ensureLoaded: jest.Mock };
    let settingsStore: { disableVod: jest.Mock };
    let seeder: StalkerContentSeedService;

    function stalkerPlaylist(scope: Partial<Playlist> = {}): Playlist {
        return {
            _id: 'playlist-1',
            title: 'Panel',
            portalUrl: 'http://panel.example/c',
            macAddress: '00:1A:79:00:00:01',
            ...scope,
        } as Playlist;
    }

    beforeEach(() => {
        dataService = {
            sendIpcEvent: jest
                .fn()
                .mockResolvedValue({ js: { data: [{ id: '1' }] } }),
        };
        session = { ensureToken: jest.fn().mockResolvedValue({ token: 't' }) };
        itvCache = { ensureLoaded: jest.fn().mockResolvedValue(undefined) };
        settingsStore = { disableVod: jest.fn(() => false) };
        TestBed.configureTestingModule({
            providers: [
                StalkerContentSeedService,
                { provide: DataService, useValue: dataService },
                { provide: StalkerSessionService, useValue: session },
                { provide: StalkerItvCacheService, useValue: itvCache },
                { provide: SettingsStore, useValue: settingsStore },
                {
                    provide: StalkerPortalRepairService,
                    useValue: {
                        waitForPendingRepair: jest.fn(),
                        applyOverride: jest.fn(
                            <T extends { _id?: string }>(playlist: T) => playlist
                        ),
                        shouldAttemptRepair: jest.fn(() => false),
                        repairPortal: jest.fn(),
                    },
                },
            ],
        });
        seeder = TestBed.inject(StalkerContentSeedService);
    });

    afterEach(() => TestBed.resetTestingModule());

    it('validates the portal with one live page and warms the channel list', async () => {
        const playlist = stalkerPlaylist();

        await seeder.seed(playlist);

        expect(dataService.sendIpcEvent).toHaveBeenCalledWith(
            STALKER_REQUEST,
            expect.objectContaining({
                url: 'http://panel.example/c',
                macAddress: '00:1A:79:00:00:01',
                params: expect.objectContaining({
                    action: 'get_ordered_list',
                    type: 'itv',
                    p: 1,
                }),
            })
        );
        // Background warm, so a slow crawl cannot spend the row's budget.
        expect(itvCache.ensureLoaded).toHaveBeenCalledWith(playlist);
    });

    it('rejects a portal that answers without live channels', async () => {
        dataService.sendIpcEvent.mockResolvedValueOnce({ js: { data: [] } });

        await expect(seeder.seed(stalkerPlaylist())).rejects.toThrow(
            'no live channels'
        );
        expect(itvCache.ensureLoaded).not.toHaveBeenCalled();
    });

    it('rejects an unreadable portal so the bulk import skips it', async () => {
        dataService.sendIpcEvent.mockRejectedValueOnce(new Error('portal down'));

        await expect(seeder.seed(stalkerPlaylist())).rejects.toThrow(
            'portal down'
        );
        expect(itvCache.ensureLoaded).not.toHaveBeenCalled();
    });

    it('validates a VOD-only row with its category list instead of live', async () => {
        dataService.sendIpcEvent.mockResolvedValueOnce({
            js: [{ id: '1', title: 'Movies' }],
        });

        await seeder.seed(stalkerPlaylist({ importLive: false, importVod: true }));

        expect(dataService.sendIpcEvent).toHaveBeenCalledWith(
            STALKER_REQUEST,
            expect.objectContaining({
                params: expect.objectContaining({
                    action: 'get_categories',
                    type: 'vod',
                }),
            })
        );
        expect(itvCache.ensureLoaded).not.toHaveBeenCalled();
    });

    it('leaves a row without a portal or MAC unseeded', async () => {
        await seeder.seed(stalkerPlaylist({ macAddress: '' }));
        await seeder.seed(stalkerPlaylist({ portalUrl: '' }));

        expect(dataService.sendIpcEvent).not.toHaveBeenCalled();
    });
});
