// Plays the relay in Electron's Chromium (the app's real web-player runtime,
// with H.264/AAC) and reports playback state plus screenshots (spike).
//   node electron-probe.mjs <relay base url> <out dir>
// live:      mpegts.js on live.ts for 60 s (spans a segment rotation)
// timeshift: hls.js on timeshift.m3u8 (2 s and 1 s HLS segments), then seek
//            back to 5 s, then to live
import { _electron as electron } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [base, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const mainJs = path.join(outDir, 'probe-main.cjs');
writeFileSync(mainJs, `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => new BrowserWindow({ width: 1280, height: 720, show: true }).loadURL('about:blank'));`);

const app = await electron.launch({ args: [mainJs] });
const page = await app.firstWindow();
const state = () => page.evaluate(() => {
    const v = document.getElementById('v');
    const q = v.getVideoPlaybackQuality();
    const b = v.buffered;
    return {
        currentTime: +v.currentTime.toFixed(2), paused: v.paused, readyState: v.readyState,
        buffered: b.length ? [+b.start(0).toFixed(2), +b.end(b.length - 1).toFixed(2)] : null,
        frames: q.totalVideoFrames, dropped: q.droppedVideoFrames, errors: window.spike.errors,
        reloads: window.spike.reloads,
    };
});
const shot = async (name) => {
    const wall = new Date().toLocaleTimeString('en-GB', { hour12: false });
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    console.log(`${name}: screenshot at wall clock ${wall}`);
};

await page.goto(`${base}/player.html?mode=live`);
for (let s = 15; s <= 60; s += 15) {
    await page.waitForTimeout(15000);
    console.log(`live ${s}s`, JSON.stringify(await state()));
    await shot(`live-${s}s`);
}
for (const target of ['2', '1']) {
    await page.goto(`${base}/player.html?mode=timeshift&target=${target}`);
    await page.waitForTimeout(15000);
    console.log(`timeshift target=${target}`, JSON.stringify(await state()));
    await shot(`timeshift-t${target}-15s`);
    if (target === '2') {
        await page.evaluate(() => { document.getElementById('v').currentTime = 5; });
        await page.waitForTimeout(4000);
        console.log('timeshift after seek to 5s', JSON.stringify(await state()));
        await shot('timeshift-seek-5s');
        await page.evaluate(() => {
            const v = document.getElementById('v');
            v.currentTime = v.buffered.end(v.buffered.length - 1) - 1;
            // Back to live: hls.js's live edge
            const h = window.spike.hls; if (h.liveSyncPosition) v.currentTime = h.liveSyncPosition;
        });
        await page.waitForTimeout(4000);
        console.log('timeshift back to live', JSON.stringify(await state()));
        await shot('timeshift-back-live');
    }
}
await app.close();
