import {
    Component,
    ChangeDetectionStrategy,
    model,
} from '@angular/core';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { TranslatePipe } from '@ngx-translate/core';

/**
 * Live-channels vs VOD (movies + series) import toggles shared by every
 * single-source form. A source that imports nothing is broken, so the last
 * checked box disables instead of clearing — a vetoed uncheck would leave
 * the natively toggled checkbox visually off while the state stays on
 * (Angular skips same-value binding writes).
 */
@Component({
    imports: [MatCheckboxModule, TranslatePipe],
    selector: 'app-import-scope',
    template: `
        <div class="import-scope">
            <p class="import-scope__label">
                {{ 'HOME.ADD_PLAYLIST.IMPORT_SCOPE_LABEL' | translate }}
            </p>
            <mat-checkbox
                [checked]="importLive()"
                [disabled]="!importVod()"
                (change)="importLive.set($event.checked)"
            >
                {{ 'HOME.ADD_PLAYLIST.IMPORT_SCOPE_LIVE' | translate }}
            </mat-checkbox>
            <mat-checkbox
                [checked]="importVod()"
                [disabled]="!importLive()"
                (change)="importVod.set($event.checked)"
            >
                {{ 'HOME.ADD_PLAYLIST.IMPORT_SCOPE_VOD' | translate }}
            </mat-checkbox>
        </div>
    `,
    styles: [
        `
            .import-scope {
                display: flex;
                flex-direction: column;
                gap: 4px;
                margin: 4px 0 12px;
            }

            .import-scope__label {
                margin: 0;
                color: var(--mat-sys-on-surface-variant);
                font-size: 12px;
            }
        `,
    ],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImportScopeComponent {
    readonly importLive = model(true);
    readonly importVod = model(true);
}
