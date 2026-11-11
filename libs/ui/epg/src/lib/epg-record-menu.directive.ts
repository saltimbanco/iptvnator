import { Directive, ElementRef, inject, input, output } from '@angular/core';
import { MatMenuTrigger } from '@angular/material/menu';
import type { EpgProgram } from '@iptvnator/shared/interfaces';

/**
 * Opens the host's "Record programme" menu at the pointer.
 *
 * Both EPG views offer the same right-click action. The trigger lookup, the
 * anchor positioning and the programme the menu is about live here, so the
 * views only forward their context menu and re-emit the chosen programme.
 * The host element is the hidden anchor the menu opens against.
 */
@Directive({ selector: '[appEpgRecordMenu]' })
export class EpgRecordMenuDirective {
    readonly trigger = input.required<MatMenuTrigger>({
        alias: 'epgRecordMenuTrigger',
    });
    readonly recordProgramRequested = output<EpgProgram>();

    private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
    private program: EpgProgram | null = null;

    /** Right-click on a programme: place the anchor and open the menu. */
    open(program: EpgProgram, event: MouseEvent): void {
        event.preventDefault();
        this.program = program;
        const x = `${event.clientX}px`;
        const y = `${event.clientY}px`;
        // The menu reads the anchor's rect when it opens; set the style
        // before opening so a first right-click lands at the pointer.
        this.host.nativeElement.style.left = x;
        this.host.nativeElement.style.top = y;
        const trigger = this.trigger();
        if (trigger.menuOpen) {
            trigger.closeMenu();
        }
        queueMicrotask(() => trigger.openMenu());
    }

    /** The menu item: the host schedules the programme it was opened for. */
    select(): void {
        if (this.program) {
            this.recordProgramRequested.emit(this.program);
        }
    }
}
