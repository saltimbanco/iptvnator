import { Notification } from 'electron';

export interface RecordingScheduleNotification {
    readonly title: string;
    readonly body: string;
}

/**
 * A toast for a schedule that started or could not start. The window is
 * usually hidden while a schedule fires, so this is the only way the user
 * learns the outcome; a platform without notifications must never break the
 * scheduler.
 */
export function notifyRecordingSchedule(
    notification: RecordingScheduleNotification
): void {
    try {
        if (!Notification.isSupported()) {
            return;
        }
        new Notification({
            title: notification.title,
            body: notification.body,
        }).show();
    } catch (error) {
        console.warn('[Recording schedule] notification failed:', error);
    }
}
