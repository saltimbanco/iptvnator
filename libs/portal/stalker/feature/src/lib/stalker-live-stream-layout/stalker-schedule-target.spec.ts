import type { ResolvedPortalPlayback } from '@iptvnator/shared/interfaces';
import {
    buildStalkerScheduleTarget,
    stalkerScheduleChannelName,
} from './stalker-schedule-target';

const playback: ResolvedPortalPlayback = {
    streamUrl: 'http://portal.example/ch/1001',
    title: '',
    isLive: true,
    headers: { Cookie: 'mac=00:1A:79:00:00:01' },
};

const channel = {
    id: 1001,
    cmd: 'ffrt4://1001',
    name: 'Sport One',
    o_name: 'Sport One HD',
    logo: 'https://cdn.example/sport.png',
};

const playlist = { _id: 'playlist-one', title: 'Portal One' };

describe('buildStalkerScheduleTarget', () => {
    it('snapshots the resolved playback and the channel metadata', () => {
        const target = buildStalkerScheduleTarget(
            channel,
            playback,
            playlist,
            'itv'
        );

        expect(target).not.toBeNull();
        expect(target?.playback).toMatchObject({
            streamUrl: 'http://portal.example/ch/1001',
            title: 'Sport One HD',
            isLive: true,
            headers: { Cookie: 'mac=00:1A:79:00:00:01' },
        });
        expect(target?.metadata).toEqual({
            channelName: 'Sport One HD',
            channelLogoUrl: 'https://cdn.example/sport.png',
            playlistId: 'playlist-one',
            playlistName: 'Portal One',
            sourceType: 'stalker',
        });
        expect(target?.refresh).toEqual({
            kind: 'stalker',
            cmd: 'ffrt4://1001',
            contentType: 'itv',
        });
    });

    it('keeps the portal command so the main process can mint a fresh link', () => {
        const target = buildStalkerScheduleTarget(
            { ...channel, cmd: '  ffrt4://radio-7  ' },
            playback,
            playlist,
            'radio'
        );

        expect(target?.refresh).toEqual({
            kind: 'stalker',
            cmd: 'ffrt4://radio-7',
            contentType: 'radio',
        });
    });

    it('omits the refresh for a row without a portal command', () => {
        const target = buildStalkerScheduleTarget(
            { ...channel, cmd: undefined },
            playback,
            playlist,
            'itv'
        );

        expect(target).not.toBeNull();
        expect(target?.refresh).toBeUndefined();
    });

    it('keeps a portal-provided playback title over the channel name', () => {
        const target = buildStalkerScheduleTarget(
            channel,
            { ...playback, title: 'Now on air' },
            playlist,
            'itv'
        );

        expect(target?.playback.title).toBe('Now on air');
        expect(target?.metadata.channelName).toBe('Sport One HD');
    });

    it('falls back to the row name and then to its id', () => {
        expect(
            stalkerScheduleChannelName({ id: 7, name: 'Plain', o_name: '  ' })
        ).toBe('Plain');
        expect(stalkerScheduleChannelName({ id: 7 })).toBe('7');
        expect(stalkerScheduleChannelName({ id: 'abc' })).toBe('abc');
    });

    it('survives a deleted playlist with no identity to store', () => {
        const target = buildStalkerScheduleTarget(
            channel,
            playback,
            null,
            'itv'
        );

        expect(target?.metadata.playlistId).toBeUndefined();
        expect(target?.metadata.playlistName).toBeUndefined();
        expect(target?.metadata.sourceType).toBe('stalker');
    });

    it('refuses a target the scheduler cannot record', () => {
        expect(
            buildStalkerScheduleTarget(
                channel,
                { ...playback, streamUrl: '' },
                playlist,
                'itv'
            )
        ).toBeNull();
        expect(
            buildStalkerScheduleTarget(
                { id: '', o_name: ' ', name: '' },
                playback,
                playlist,
                'itv'
            )
        ).toBeNull();
    });
});
