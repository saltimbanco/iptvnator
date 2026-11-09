// Incremental MPEG-TS indexer over the recorder's growing segment files
// (spike). Treats the segments as one virtual byte stream, finds video
// keyframes (PES start with random_access_indicator) with their PTS, and
// keeps the latest PAT/PMT packets so a live reader can start at a keyframe.
// mpv's stream-record rebases every file to start near 0, so each segment
// is its own timeline: HLS marks a discontinuity at each segment boundary.
import { openSync, readSync, closeSync, statSync } from 'node:fs';

const PACKET = 188;

export class RecordingIndex {
    segments = []; // { path, base, size }
    keyframes = []; // { offset (virtual), pts (90 kHz), segment }
    pat = null;
    pmt = null;
    pmtPid = -1;
    videoPid = -1;
    ended = false;
    #pending = Buffer.alloc(0);
    #scanned = 0; // virtual bytes scanned

    addSegment(path) {
        const last = this.segments.at(-1);
        this.refresh();
        this.segments.push({ path, base: last ? last.base + last.size : 0, size: 0 });
    }

    get size() {
        const last = this.segments.at(-1);
        return last ? last.base + last.size : 0;
    }

    /** Re-stat the open segment and index any new whole packets. */
    refresh() {
        const seg = this.segments.at(-1);
        if (!seg) return;
        let size = 0;
        try { size = statSync(seg.path).size; } catch { return; }
        if (size <= seg.size) return;
        const fd = openSync(seg.path, 'r');
        const chunk = Buffer.alloc(size - seg.size);
        readSync(fd, chunk, 0, chunk.length, seg.size);
        closeSync(fd);
        seg.size = size;
        this.#scan(chunk);
    }

    #scan(chunk) {
        let buf = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
        let i = 0;
        while (i + PACKET <= buf.length) {
            if (buf[i] !== 0x47) { i++; this.#scanned++; continue; } // resync
            this.#packet(buf.subarray(i, i + PACKET), this.#scanned);
            i += PACKET;
            this.#scanned += PACKET;
        }
        this.#pending = Buffer.from(buf.subarray(i));
    }

    #packet(pkt, offset) {
        const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
        const pusi = (pkt[1] & 0x40) !== 0;
        const afc = (pkt[3] >> 4) & 3;
        let p = 4;
        let rai = false;
        if (afc & 2) {
            const len = pkt[4];
            rai = len > 0 && (pkt[5] & 0x40) !== 0;
            p = 5 + len;
        }
        if (!(afc & 1) || p >= PACKET) return;
        if (pid === 0 && pusi) {
            this.pat = Buffer.from(pkt);
            const s = p + 1 + pkt[p]; // pointer field
            this.pmtPid = ((pkt[s + 10] & 0x1f) << 8) | pkt[s + 11];
            return;
        }
        if (pid === this.pmtPid && pusi) {
            this.pmt = Buffer.from(pkt);
            if (this.videoPid < 0) this.videoPid = parseVideoPid(pkt, p);
            return;
        }
        if (pid === this.videoPid && pusi && rai &&
            pkt[p] === 0 && pkt[p + 1] === 0 && pkt[p + 2] === 1 && (pkt[p + 7] & 0x80)) {
            const b = pkt.subarray(p + 9, p + 14);
            const pts = (b[0] & 0x0e) * 536870912 + b[1] * 4194304 + (b[2] & 0xfe) * 16384 +
                b[3] * 128 + (b[4] >> 1);
            this.keyframes.push({ offset, pts, segment: this.segmentAt(offset) });
        }
    }

    segmentAt(offset) {
        let i = this.segments.length - 1;
        while (i > 0 && this.segments[i].base > offset) i--;
        return i;
    }

    /** Seconds indexed, summed per segment timeline. */
    get indexedSeconds() {
        let total = 0;
        for (let s = 0; s < this.segments.length; s++) {
            const k = this.keyframes.filter((f) => f.segment === s);
            if (k.length > 1) total += (k.at(-1).pts - k[0].pts) / 90000;
        }
        return total;
    }

    /** Reads virtual bytes [start, end) across segment files. */
    read(start, end) {
        const out = [];
        for (const seg of this.segments) {
            const s = Math.max(start, seg.base);
            const e = Math.min(end, seg.base + seg.size);
            if (s >= e) continue;
            const fd = openSync(seg.path, 'r');
            const b = Buffer.alloc(e - s);
            readSync(fd, b, 0, b.length, s - seg.base);
            closeSync(fd);
            out.push(b);
        }
        return Buffer.concat(out);
    }

    /**
     * Groups keyframes into HLS segments of about `target` seconds, never
     * across a recording segment. A finished recording segment's last group
     * runs to its end; the first group of a later segment is a discontinuity.
     */
    hlsSegments(target = 2) {
        const out = [];
        for (let s = 0; s < this.segments.length; s++) {
            const k = this.keyframes.filter((f) => f.segment === s);
            const seg = this.segments[s];
            const closed = s < this.segments.length - 1 || this.ended;
            let i = 0;
            let first = true;
            const push = (offset, end, duration) => {
                out.push({ offset, length: end - offset, duration, discontinuity: first && s > 0 });
                first = false;
            };
            while (i < k.length - 1) {
                let j = i + 1;
                while (j < k.length - 1 && (k[j].pts - k[i].pts) / 90000 < target) j++;
                push(k[i].offset, k[j].offset, (k[j].pts - k[i].pts) / 90000);
                i = j;
            }
            if (closed && k.length && seg.base + seg.size > k[i].offset) {
                // Last group: duration from the GOP spacing seen so far.
                const gop = k.length > 1 ? (k.at(-1).pts - k[0].pts) / 90000 / (k.length - 1) : target;
                push(k[i].offset, seg.base + seg.size, gop);
            }
        }
        return out;
    }
}

function parseVideoPid(pkt, p) {
    const s = p + 1 + pkt[p];
    const sectionLength = ((pkt[s + 1] & 0x0f) << 8) | pkt[s + 2];
    const programInfoLength = ((pkt[s + 10] & 0x0f) << 8) | pkt[s + 11];
    let q = s + 12 + programInfoLength;
    const end = s + 3 + sectionLength - 4;
    while (q + 5 <= end) {
        const type = pkt[q];
        const pid = ((pkt[q + 1] & 0x1f) << 8) | pkt[q + 2];
        if ([0x01, 0x02, 0x1b, 0x24].includes(type)) return pid;
        q += 5 + (((pkt[q + 3] & 0x0f) << 8) | pkt[q + 4]);
    }
    return -1;
}
