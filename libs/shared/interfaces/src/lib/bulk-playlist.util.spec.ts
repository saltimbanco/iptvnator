import {
    bulkEntriesFromJson,
    bulkEntryToPlaylist,
    candidatesToBulkEntries,
    isDirectBulkPlaylistEntry,
    isImportableCandidate,
} from './bulk-playlist.util';

describe('bulk playlist entries', () => {
    it('maps candidates to editable rows defaulting to a full scope', () => {
        const [xtream, stalker] = candidatesToBulkEntries([
            {
                kind: 'xtream',
                confidence: 'high',
                serverUrl: 'http://panel.example',
                username: 'user',
                password: 'pass',
                suggestedTitle: 'panel.example',
            },
            {
                kind: 'stalker',
                confidence: 'high',
                portalUrl: 'http://portal.example/c/',
                macAddress: '00:11:22:33:44:55',
            },
        ]);

        expect(xtream.title).toBe('panel.example');
        expect(xtream.valid).toBe(true);
        expect(stalker.title).toBe('Source 2');
        expect(isDirectBulkPlaylistEntry(xtream)).toBe(true);
        expect(xtream.id).not.toBe(stalker.id);
    });

    it('flags incomplete rows as invalid', () => {
        expect(
            isImportableCandidate({ kind: 'xtream', confidence: 'low' })
        ).toBe(false);
        expect(
            isImportableCandidate({
                kind: 'm3u-url',
                confidence: 'high',
                url: 'http://x.example/list.m3u',
            })
        ).toBe(true);
        expect(
            isImportableCandidate({
                kind: 'm3u-text',
                confidence: 'high',
                text: '   ',
            })
        ).toBe(false);
    });

    it('builds portal playlists carrying a partial scope', () => {
        const [entry] = candidatesToBulkEntries([
            {
                kind: 'xtream',
                confidence: 'high',
                serverUrl: 'http://panel.example',
                username: 'user',
                password: 'pass',
            },
        ]);
        const playlist = bulkEntryToPlaylist({
            ...entry,
            importVod: false,
        });

        expect(playlist?.serverUrl).toBe('http://panel.example');
        expect(playlist?.importVod).toBe(false);
        expect(playlist?.importLive).toBeUndefined();
    });

    it('returns null for M3U rows and incomplete portal rows', () => {
        const [m3u, broken] = candidatesToBulkEntries([
            {
                kind: 'm3u-url',
                confidence: 'high',
                url: 'http://x.example/list.m3u',
            },
            { kind: 'xtream', confidence: 'low' },
        ]);
        expect(isDirectBulkPlaylistEntry(m3u)).toBe(false);
        expect(bulkEntryToPlaylist(m3u)).toBeNull();
        expect(bulkEntryToPlaylist(broken)).toBeNull();
    });

    it('parses a structured JSON source list', () => {
        const entries = bulkEntriesFromJson({
            sources: [
                {
                    type: 'xtream',
                    title: 'Gold',
                    serverUrl: 'http://panel.example',
                    username: 'user',
                    password: 'pass',
                    importVod: false,
                },
                {
                    type: 'm3u-url',
                    url: 'http://x.example/list.m3u',
                },
                { type: 'unknown-thing' },
            ],
        });

        expect(entries).toHaveLength(2);
        expect(entries?.[0]).toMatchObject({
            kind: 'xtream',
            title: 'Gold',
            importVod: false,
            valid: true,
        });
        expect(entries?.[1].title).toBe('Source 2');
    });

    it('rejects JSON that is not a source list', () => {
        expect(bulkEntriesFromJson({ playlists: [] })).toBeNull();
        expect(bulkEntriesFromJson('just text')).toBeNull();
    });
});
