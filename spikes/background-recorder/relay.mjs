// Localhost relay over a growing recording (spike).
//   GET /<token>/live.ts         live tail: PAT+PMT, then from the newest
//                                keyframe, following new bytes and segments
//   GET /<token>/timeshift.m3u8  HLS EVENT playlist, byte ranges into rec.ts
//   GET /<token>/rec.ts          the segments as one file, with Range support
//   GET /<token>/player.html     test page (mpegts.js live / hls.js timeshift)
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export function createRelay({ index, token, port = 0, host = '127.0.0.1', staticDir }) {
    const live = new Set();
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://relay');
        const [, tok, name] = url.pathname.split('/');
        if (tok !== token) return void res.writeHead(404).end();
        index.refresh();
        if (name === 'live.ts') return serveLive(res);
        if (name === 'timeshift.m3u8') return servePlaylist(res, Number(url.searchParams.get('target') ?? 2));
        if (name === 'rec.ts') return serveRange(req, res);
        if (name === 'player.html' || name === 'vendor') {
            const file = name === 'vendor' ? path.join(staticDir, 'vendor', path.basename(url.pathname))
                : path.join(staticDir, 'player.html');
            const type = file.endsWith('.html') ? 'text/html' : 'text/javascript';
            return void res.writeHead(200, { 'Content-Type': type }).end(readFileSync(file));
        }
        res.writeHead(404).end();
    });

    function serveLive(res) {
        const kf = index.keyframes.at(-1);
        if (!kf || !index.pat || !index.pmt) return void res.writeHead(503).end();
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
        res.write(Buffer.concat([index.pat, index.pmt]));
        const reader = { res, pos: kf.offset, segment: kf.segment };
        live.add(reader);
        res.on('close', () => live.delete(reader));
        pump();
    }

    function servePlaylist(res, wanted) {
        const segs = index.hlsSegments(wanted);
        const target = Math.ceil(Math.max(wanted, ...segs.map((s) => s.duration)));
        const lines = ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-PLAYLIST-TYPE:EVENT',
            `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0'];
        for (const s of segs) {
            if (s.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
            lines.push(`#EXTINF:${s.duration.toFixed(3)},`, `#EXT-X-BYTERANGE:${s.length}@${s.offset}`, 'rec.ts');
        }
        if (index.ended) lines.push('#EXT-X-ENDLIST');
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        res.end(lines.join('\n') + '\n');
    }

    function serveRange(req, res) {
        const size = index.size;
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
        const start = m ? Number(m[1]) : 0;
        const end = m && m[2] ? Math.min(Number(m[2]) + 1, size) : size;
        if (start >= end) return void res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        const body = index.read(start, end);
        res.writeHead(m ? 206 : 200, {
            'Content-Type': 'video/mp2t', 'Accept-Ranges': 'bytes', 'Content-Length': body.length,
            'Access-Control-Allow-Origin': '*',
            ...(m ? { 'Content-Range': `bytes ${start}-${end - 1}/${size}` } : {}),
        });
        res.end(body);
    }

    function pump() {
        index.refresh();
        for (const reader of live) {
            // A live response never crosses into the next recording segment:
            // its timestamps restart, so the player reloads live.ts instead.
            const seg = index.segments[reader.segment];
            const segEnd = seg.base + seg.size;
            const closed = reader.segment < index.segments.length - 1 || index.ended;
            if (closed && reader.pos >= segEnd) { reader.res.end(); live.delete(reader); continue; }
            if (reader.pos >= segEnd || reader.res.writableNeedDrain) continue;
            const end = Math.min(segEnd, reader.pos + 1024 * 1024);
            reader.res.write(index.read(reader.pos, end));
            reader.pos = end;
        }
    }
    const timer = setInterval(pump, 100);

    return new Promise((resolve) => server.listen(port, host, () => resolve({
        url: `http://${host}:${server.address().port}/${token}`,
        close: () => { clearInterval(timer); for (const r of live) r.res.end(); server.close(); },
    })));
}
