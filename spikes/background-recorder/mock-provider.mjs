// Synthetic live IPTV source for the recorder spike: one ffmpeg encoder
// (test pattern + tone, burned-in clock) broadcast as MPEG-TS over HTTP to
// every client. Logs each connection's User-Agent / Referer / X-Token and the
// number of concurrent connections, so the spike can show that recording
// plus watching uses one provider connection.
//
//   node mock-provider.mjs [port=8099]
//   GET /live/<name>.ts   (requires header X-Token: spike, like a provider
//                          that checks headers; ?drop=N closes after N s)
import { spawn } from 'node:child_process';
import http from 'node:http';

const port = Number(process.argv[2] ?? 8099);
const clients = new Set();
let open = 0;
let peak = 0;

const ffmpeg = spawn(
    'ffmpeg',
    [
        '-hide_banner', '-loglevel', 'error', '-re',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-vf', "drawtext=text='%{localtime\\:%T}':fontsize=64:x=40:y=40:fontcolor=white:box=1:boxcolor=black",
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
        '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-b:v', '2500k',
        // SPS/PPS on every keyframe, like broadcast IPTV, so mid-stream joins decode.
        '-x264-params', 'repeat-headers=1',
        '-c:a', 'aac', '-b:a', '128k',
        '-f', 'mpegts', '-mpegts_flags', 'resend_headers', 'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
);
ffmpeg.stdout.on('data', (chunk) => {
    for (const res of clients) res.write(chunk);
});

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/live/')) {
        res.writeHead(404).end();
        return;
    }
    if (req.headers['x-token'] !== 'spike') {
        console.log(`reject (no X-Token) ua=${req.headers['user-agent']}`);
        res.writeHead(403).end();
        return;
    }
    open++;
    peak = Math.max(peak, open);
    console.log(
        `connect #${open} (peak ${peak}) ua="${req.headers['user-agent']}" referer="${req.headers.referer ?? ''}"`
    );
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    clients.add(res);
    const drop = Number(url.searchParams.get('drop') ?? 0);
    const timer = drop ? setTimeout(() => res.destroy(), drop * 1000) : null;
    req.on('close', () => {
        clearTimeout(timer);
        clients.delete(res);
        open--;
        console.log(`disconnect (open ${open})`);
    });
}).listen(port, () => console.log(`mock provider on http://127.0.0.1:${port}/live/<name>.ts`));
