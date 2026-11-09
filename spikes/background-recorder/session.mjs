// One background recording session (spike): drives
// iptvnator_mpv_recorder.exe the way the main-process service would, rotates
// segments, and serves them through the relay. Runs on Windows Node.
//
//   node session.mjs --bin <dir> --out <dir> --url <stream> [--duration 60]
//        [--rotate-every 0] [--port 8790] [--token <t>] [--relay-host 127.0.0.1]
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRelay } from './relay.mjs';
import { RecordingIndex } from './ts-index.mjs';

const { values: opt } = parseArgs({ options: {
    bin: { type: 'string' }, out: { type: 'string' }, url: { type: 'string' },
    duration: { type: 'string', default: '60' }, 'rotate-every': { type: 'string', default: '0' },
    port: { type: 'string', default: '8790' }, token: { type: 'string' },
    'relay-host': { type: 'string', default: '127.0.0.1' },
} });
// mpv does not create the folder; it reports record-failed instead.
mkdirSync(opt.out, { recursive: true });
const started = Date.now();
const log = (msg) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${msg}`);

const encode = (v) => String(v).replace(/[%\t\r\n]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
const index = new RecordingIndex();
const child = spawn(path.join(opt.bin, 'iptvnator_mpv_recorder.exe'), [], {
    stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
});
const send = (name, args = {}) => child.stdin.write(
    [name, ...Object.entries(args).map(([k, v]) => `${k}=${encode(v)}`)].join('\t') + '\n');
let segmentNo = 0;
const nextSegment = () => {
    const file = path.join(opt.out, `segment-${++segmentNo}.ts`);
    index.addSegment(file);
    return file;
};

readline.createInterface({ input: child.stdout }).on('line', (raw) => {
    const e = JSON.parse(raw);
    if (e.event === 'log') return;
    log(raw);
    if (e.event === 'ready') {
        send('open', {
            url: opt.url, path: nextSegment(), 'user-agent': 'IPTVnator-Recorder-Spike/1.0',
            referrer: 'http://portal.example.test/', headers: 'X-Token: spike',
        });
    }
});

const relay = await createRelay({
    index, token: opt.token ?? randomBytes(12).toString('hex'), port: Number(opt.port),
    host: opt['relay-host'], staticDir: path.dirname(fileURLToPath(import.meta.url)),
});
log(`relay ${relay.url}/live.ts | ${relay.url}/timeshift.m3u8 | ${relay.url}/player.html`);

const rotateEvery = Number(opt['rotate-every']);
const rotation = rotateEvery ? setInterval(() => send('rotate', { path: nextSegment() }), rotateEvery * 1000) : null;
const status = setInterval(() => {
    index.refresh();
    log(`recorded ${(index.size / 1e6).toFixed(1)} MB, ${segmentNo} segment(s), ${index.indexedSeconds.toFixed(1)}s indexed`);
}, 10000);

setTimeout(() => {
    try {
        const cpu = execFileSync('powershell.exe', ['-NoProfile', '-Command',
            `$p=Get-Process -Id ${child.pid}; "$($p.TotalProcessorTime.TotalSeconds)s cpu, $([math]::Round($p.WorkingSet64/1MB)) MB"`]).toString().trim();
        log(`recorder ${cpu}`);
    } catch {}
    clearInterval(rotation);
    clearInterval(status);
    send('stop');
    setTimeout(() => send('quit'), 300);
}, Number(opt.duration) * 1000);

child.on('exit', (code) => {
    index.refresh();
    index.ended = true;
    log(`recorder exited ${code}; ${(index.size / 1e6).toFixed(1)} MB in ${segmentNo} segment(s)`);
    setTimeout(() => { relay.close(); process.exit(0); }, 3000);
});
