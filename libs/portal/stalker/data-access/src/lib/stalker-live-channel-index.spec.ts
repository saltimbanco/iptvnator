import { parseStalkerLiveChannelIndex } from '@iptvnator/shared/interfaces';
import type { StalkerItvChannel } from './models';
import {
    persistStalkerLiveChannelIndex,
    toStalkerLiveIndexEntries,
} from './stalker-live-channel-index';

describe('stalker live channel index', () => {
    function channel(
        id: string,
        name: string | undefined,
        genreId?: string
    ): StalkerItvChannel {
        return {
            id,
            name,
            cmd: `ffrt http://stream.example/${id}`,
            tv_genre_id: genreId,
        } as StalkerItvChannel;
    }

    it('keeps the provider id, name and genre of every named channel', () => {
        expect(
            toStalkerLiveIndexEntries([
                channel('901', 'ERT 1 HD', '12'),
                channel('902', 'Mega', '12'),
            ])
        ).toEqual([
            { id: '901', title: 'ERT 1 HD', genreId: '12', logo: null },
            { id: '902', title: 'Mega', genreId: '12', logo: null },
        ]);
    });

    it('drops channels it cannot open or name, and duplicate ids', () => {
        const entries = toStalkerLiveIndexEntries([
            channel('901', 'ERT 1'),
            channel('901', 'ERT 1 copy'),
            channel('', 'Nameless id'),
        ]);

        expect(entries).toEqual([
            { id: '901', title: 'ERT 1', genreId: null, logo: null },
        ]);
    });

    it('persists the list under the portal key the failover reads', async () => {
        const setAppState = jest.fn().mockResolvedValue(true);

        await persistStalkerLiveChannelIndex({ setAppState }, 'portal-b', [
            channel('901', 'ERT 1', '12'),
        ]);

        expect(setAppState).toHaveBeenCalledWith(
            'stalker-live-channel-index:portal-b',
            JSON.stringify([
                { id: '901', title: 'ERT 1', genreId: '12', logo: null },
            ])
        );
    });

    it('leaves a broken or absent index empty instead of throwing', () => {
        expect(parseStalkerLiveChannelIndex(null)).toEqual([]);
        expect(parseStalkerLiveChannelIndex('not json')).toEqual([]);
        expect(parseStalkerLiveChannelIndex('{"id":"1"}')).toEqual([]);
        expect(
            parseStalkerLiveChannelIndex(
                JSON.stringify([
                    { id: '901', title: 'ERT 1', genreId: '12', logo: null },
                    { id: '', title: 'Nameless' },
                ])
            )
        ).toEqual([
            { id: '901', title: 'ERT 1', genreId: '12', logo: null },
        ]);
    });
});
