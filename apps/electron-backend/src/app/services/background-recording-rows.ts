import type {
    BackgroundRecordingOrigin,
    RecordingStartMetadata,
} from '@iptvnator/shared/interfaces';
import { and, eq } from 'drizzle-orm';
import { getDatabase } from '../database/connection';
import * as schema from '../database/schema';
import { broadcastRecordingsUpdate } from '../events/database/recording-broadcast';

export interface RecordingRowStart {
    recordingId: string;
    filePath: string;
    metadata: RecordingStartMetadata;
    origin: BackgroundRecordingOrigin;
    startedAt: string;
}

export interface RecordingRowEnd {
    status: 'completed' | 'interrupted' | 'failed';
    fileSizeBytes: number | null;
    errorMessage?: string;
    endedAt: string;
}

/** The `recordings` rows of background recordings, one per file. */
export interface RecordingRowsStore {
    insert(start: RecordingRowStart): Promise<number | null>;
    finalize(rowId: Promise<number | null>, end: RecordingRowEnd): void;
    /** Resolves once every write enqueued so far has committed. */
    whenSettled(): Promise<void>;
    /** Rows still persisted as `recording` by this process. */
    activeRowIds(): Promise<Set<number>>;
}

/**
 * Writes are serialized, like the embedded MPV recording tracker's, so a
 * file that ends right after it started cannot be finalized before its row
 * exists. Rows carry this process' pid for startup recovery.
 */
export function createRecordingRowsStore(): RecordingRowsStore {
    let chain: Promise<unknown> = Promise.resolve();
    // Inserted rows whose terminal update has not committed yet; startup
    // recovery must leave them alone.
    const open = new Set<Promise<number | null>>();
    const enqueue = <T>(work: () => Promise<T>): Promise<T | null> => {
        const result = chain.then(work).catch((error) => {
            console.error('[Background recording] row write failed:', error);
            return null;
        });
        chain = result;
        return result;
    };

    return {
        insert(start) {
            const { metadata } = start;
            const rowId = enqueue(async () => {
                const db = await getDatabase();
                const result = await db.insert(schema.recordings).values({
                    sessionId: start.recordingId,
                    ownerPid: process.pid,
                    origin: start.origin,
                    status: 'recording',
                    filePath: start.filePath,
                    channelName: metadata.channelName,
                    channelLogoUrl: metadata.channelLogoUrl,
                    playlistId: metadata.playlistId,
                    playlistName: metadata.playlistName,
                    sourceType: metadata.sourceType,
                    epgChannelId: metadata.epgChannelId,
                    programTitle: metadata.currentProgram?.title,
                    programDescription: metadata.currentProgram?.description,
                    programStart: metadata.currentProgram?.start,
                    programStop: metadata.currentProgram?.stop,
                    startedAt: start.startedAt,
                });
                return Number(result.lastInsertRowid);
            });
            open.add(rowId);
            void rowId.then((id) => id !== null && broadcastRecordingsUpdate());
            return rowId;
        },
        finalize(rowIdPromise, end) {
            const done = enqueue(async () => {
                const rowId = await rowIdPromise;
                if (rowId === null) {
                    return;
                }
                const db = await getDatabase();
                await db
                    .update(schema.recordings)
                    .set({
                        status: end.status,
                        fileSizeBytes: end.fileSizeBytes,
                        endedAt: end.endedAt,
                        updatedAt: new Date().toISOString(),
                        ...(end.errorMessage
                            ? { errorMessage: end.errorMessage }
                            : {}),
                    })
                    .where(
                        and(
                            eq(schema.recordings.id, rowId),
                            eq(schema.recordings.status, 'recording')
                        )
                    );
                broadcastRecordingsUpdate();
            });
            void done.then(() => open.delete(rowIdPromise));
        },
        whenSettled() {
            return chain.then(() => undefined);
        },
        async activeRowIds() {
            const ids = await Promise.all(open);
            return new Set(ids.filter((id): id is number => id !== null));
        },
    };
}
