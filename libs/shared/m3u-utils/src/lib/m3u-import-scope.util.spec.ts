import {
    applyImportScopeToPlaylist,
    filterM3uItemsByImportScope,
} from './m3u-import-scope.util';

const live = { url: 'http://host/live/123.ts' };
const movie = { url: 'http://host/movie/123.mp4' };
const items = [live, movie];

describe('filterM3uItemsByImportScope', () => {
    it('returns the input untouched for a full scope', () => {
        expect(filterM3uItemsByImportScope(items, undefined)).toBe(items);
        expect(
            filterM3uItemsByImportScope(items, {
                importLive: true,
                importVod: true,
            })
        ).toBe(items);
    });

    it('drops VOD entries when VOD import is off', () => {
        expect(
            filterM3uItemsByImportScope(items, { importVod: false })
        ).toEqual([live]);
    });

    it('drops live entries when live import is off', () => {
        expect(
            filterM3uItemsByImportScope(items, { importLive: false })
        ).toEqual([movie]);
    });
});

describe('applyImportScopeToPlaylist', () => {
    const playlist = (items: Array<{ url: string }>) =>
        ({
            _id: 'playlist-1',
            title: 'List',
            count: items.length,
            playlist: { items },
        }) as Parameters<typeof applyImportScopeToPlaylist>[0];

    it('returns the playlist untouched for a full scope', () => {
        const input = playlist([live, movie]);

        expect(applyImportScopeToPlaylist(input, undefined)).toBe(input);
    });

    it('filters items, fixes the count and stamps the opt-out', () => {
        const next = applyImportScopeToPlaylist(playlist([live, movie]), {
            importVod: false,
        });

        expect(next.playlist.items).toEqual([live]);
        expect(next.count).toBe(1);
        expect(next.importVod).toBe(false);
        expect(next.importLive).toBeUndefined();
    });

    it('strips a stale opt-out when the scope is full again', () => {
        const next = applyImportScopeToPlaylist(
            { ...playlist([live]), importVod: false },
            undefined
        );

        expect(next.importVod).toBeUndefined();
    });
});
