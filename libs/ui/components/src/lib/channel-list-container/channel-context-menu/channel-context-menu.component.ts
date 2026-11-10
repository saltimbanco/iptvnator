import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    computed,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { TranslatePipe } from '@ngx-translate/core';

/** The pointer position a context menu opens at. */
export type ChannelContextMenuPoint = Pick<MouseEvent, 'clientX' | 'clientY'>;

/**
 * The right-click menu of a channel row, shared by every channel list (M3U
 * views, Xtream and Stalker live lists, unified favorites and recents).
 *
 * The host keeps the channel the menu was opened for and its own handlers;
 * this component owns the anchor, the menu and its rows, which always come
 * in one order: Map EPG, Schedule recording, Show details, View in a
 * playlist, and Remove from history as a destructive row after a divider.
 */
@Component({
    selector: 'app-channel-context-menu',
    imports: [MatDividerModule, MatIconModule, MatMenuModule, TranslatePipe],
    templateUrl: './channel-context-menu.component.html',
    styleUrl: './channel-context-menu.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelContextMenuComponent {
    readonly showMapEpg = input(false);
    readonly showDetails = input(false);
    /**
     * "Schedule recording…": Electron builds whose main process owns the
     * scheduler. Hidden everywhere else (PWA, older bridges).
     */
    readonly showScheduleRecording = input(false);
    /**
     * The playlist to offer "View in …" for; no row while null. An empty
     * name (a playlist saved without one) still shows the row.
     */
    readonly openInPlaylistName = input<string | null>(null);
    readonly showRemoveFromHistory = input(false);

    readonly mapEpg = output<void>();
    readonly scheduleRecording = output<void>();
    readonly details = output<void>();
    readonly openInPlaylist = output<void>();
    readonly removeFromHistory = output<void>();

    protected readonly position = signal({ x: '0px', y: '0px' });
    protected readonly hasLeadingRows = computed(
        () =>
            this.showMapEpg() ||
            this.showScheduleRecording() ||
            this.showDetails() ||
            this.openInPlaylistName() !== null
    );

    private readonly trigger = viewChild.required(MatMenuTrigger);
    private readonly anchor = viewChild.required<ElementRef<HTMLElement>>(
        'anchor'
    );

    /** Opens the menu at the pointer, replacing a menu that is still open. */
    open(point: ChannelContextMenuPoint): void {
        const x = `${point.clientX}px`;
        const y = `${point.clientY}px`;
        this.position.set({ x, y });
        // The binding only reaches the DOM with the next render, but the menu
        // reads the anchor's rect when it opens — so on a session's first
        // right-click it opened at the viewport origin instead of the pointer.
        const anchor = this.anchor().nativeElement;
        anchor.style.left = x;
        anchor.style.top = y;
        const trigger = this.trigger();
        if (trigger.menuOpen) {
            trigger.closeMenu();
        }
        queueMicrotask(() => this.trigger().openMenu());
    }

    close(): void {
        this.trigger().closeMenu();
    }
}
