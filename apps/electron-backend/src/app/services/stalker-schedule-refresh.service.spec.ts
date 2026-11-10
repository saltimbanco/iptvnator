import {
    refreshStalkerSchedulePlayback,
    type StalkerSchedulePortal,
    type StalkerSchedulePortalResponse,
    type StalkerScheduleTransport,
} from './stalker-schedule-refresh.service';

const PORTAL: StalkerSchedulePortal = {
    portalUrl: 'http://portal.example/stalker_portal/server/load.php',
    macAddress: '00:1A:79:00:00:01',
};

function transportOf(
    answers: StalkerSchedulePortalResponse[]
): jest.MockedFunction<StalkerScheduleTransport> {
    const transport = jest.fn<Promise<StalkerSchedulePortalResponse>, [Parameters<StalkerScheduleTransport>[0]]>();
    for (const answer of answers) {
        transport.mockResolvedValueOnce(answer);
    }
    return transport;
}

function refresh(cmd = 'ffrt4://1001', contentType: 'itv' | 'radio' = 'itv') {
    return { kind: 'stalker' as const, cmd, contentType };
}

describe('refreshStalkerSchedulePlayback', () => {
    it('handshakes, mints a link and returns the portal headers', async () => {
        const transport = transportOf([
            { js: { token: ' TOKEN-1 ' } },
            { js: { cmd: 'http://portal.example/ch/1001?token=fresh' } },
        ]);

        const playback = await refreshStalkerSchedulePlayback(
            { refresh: refresh(), playlistId: 'playlist-1', title: 'Sport' },
            { getPortal: async () => PORTAL, transport }
        );

        expect(playback).toMatchObject({
            streamUrl: 'http://portal.example/ch/1001?token=fresh',
            title: 'Sport',
            isLive: true,
        });
        expect(playback?.headers).toMatchObject({
            Cookie: expect.stringContaining('mac=00:1A:79:00:00:01'),
            Authorization: 'Bearer TOKEN-1',
            Origin: 'http://portal.example',
        });
        expect(playback?.userAgent).toBe(playback?.headers?.['User-Agent']);

        expect(transport).toHaveBeenCalledTimes(2);
        expect(transport.mock.calls[0][0].params).toMatchObject({
            type: 'stb',
            action: 'handshake',
        });
        expect(transport.mock.calls[1][0]).toMatchObject({
            portal: PORTAL,
            token: 'TOKEN-1',
        });
        expect(transport.mock.calls[1][0].params).toMatchObject({
            type: 'itv',
            action: 'create_link',
            cmd: 'ffrt4://1001',
        });
    });

    it('asks for a radio link for a radio row', async () => {
        const transport = transportOf([
            { js: { token: 'TOKEN-1' } },
            { js: { cmd: 'http://portal.example/radio/7' } },
        ]);

        await refreshStalkerSchedulePlayback(
            {
                refresh: refresh('ffrt4://7', 'radio'),
                playlistId: 'playlist-1',
            },
            { getPortal: async () => PORTAL, transport }
        );

        expect(transport.mock.calls[1][0].params).toMatchObject({
            type: 'radio',
        });
    });

    it('normalizes a marker-prefixed and a portal-relative answer', async () => {
        const wrapped = transportOf([
            { js: { token: 'TOKEN-1' } },
            { js: { cmd: 'ffrt4 http://cdn.example/live/9.m3u8' } },
        ]);
        const relative = transportOf([
            { js: { token: 'TOKEN-1' } },
            { js: { cmd: '/media/live/9.m3u8' } },
        ]);

        const first = await refreshStalkerSchedulePlayback(
            { refresh: refresh(), playlistId: 'playlist-1' },
            { getPortal: async () => PORTAL, transport: wrapped }
        );
        const second = await refreshStalkerSchedulePlayback(
            { refresh: refresh(), playlistId: 'playlist-1' },
            { getPortal: async () => PORTAL, transport: relative }
        );

        expect(first?.streamUrl).toBe('http://cdn.example/live/9.m3u8');
        expect(second?.streamUrl).toBe(
            'http://portal.example/media/live/9.m3u8'
        );
    });

    it('ignores a stream on a foreign host for the credentials', async () => {
        const transport = transportOf([
            { js: { token: 'TOKEN-1' } },
            { js: { cmd: 'http://cdn.example/live/9.m3u8' } },
        ]);

        const playback = await refreshStalkerSchedulePlayback(
            { refresh: refresh(), playlistId: 'playlist-1' },
            { getPortal: async () => PORTAL, transport }
        );

        expect(playback?.headers).not.toHaveProperty('Authorization');
        expect(playback?.headers).not.toHaveProperty('Cookie');
    });

    it('gives up quietly when the portal cannot supply a link', async () => {
        const noSession = transportOf([{ js: {} }]);
        const refused = transportOf([
            { js: { token: 'TOKEN-1' } },
            { js: { error: 'access denied' } },
        ]);
        const empty = transportOf([
            { js: { token: 'TOKEN-1' } },
            { js: { cmd: '' } },
        ]);

        for (const transport of [noSession, refused, empty]) {
            await expect(
                refreshStalkerSchedulePlayback(
                    { refresh: refresh(), playlistId: 'playlist-1' },
                    { getPortal: async () => PORTAL, transport }
                )
            ).resolves.toBeNull();
        }
    });

    it('does not call the portal without a playlist identity', async () => {
        const transport = transportOf([]);
        const getPortal = jest.fn(async () => PORTAL);

        await expect(
            refreshStalkerSchedulePlayback(
                { refresh: refresh('   '), playlistId: 'playlist-1' },
                { getPortal, transport }
            )
        ).resolves.toBeNull();
        await expect(
            refreshStalkerSchedulePlayback(
                { refresh: refresh(), playlistId: null },
                { getPortal, transport }
            )
        ).resolves.toBeNull();
        await expect(
            refreshStalkerSchedulePlayback(
                { refresh: refresh(), playlistId: 'deleted' },
                { getPortal: async () => null, transport }
            )
        ).resolves.toBeNull();

        expect(transport).not.toHaveBeenCalled();
    });

    it('survives a transport that throws', async () => {
        const transport = jest.fn(async () => {
            throw new Error('ECONNREFUSED');
        }) as unknown as StalkerScheduleTransport;

        await expect(
            refreshStalkerSchedulePlayback(
                { refresh: refresh(), playlistId: 'playlist-1' },
                { getPortal: async () => PORTAL, transport }
            )
        ).resolves.toBeNull();
    });
});
