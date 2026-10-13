import {
    Component,
    EventEmitter,
    Output,
    signal,
    ChangeDetectionStrategy,
} from '@angular/core';
import {
    FormControl,
    FormGroup,
    ReactiveFormsModule,
    Validators,
} from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import { ImportScopeComponent } from '../import-scope/import-scope.component';

@Component({
    selector: 'app-text-import',
    templateUrl: './text-import.component.html',
    styleUrls: ['./text-import.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        ImportScopeComponent,
        MatInputModule,
        ReactiveFormsModule,
        TranslatePipe,
    ],
})
export class TextImportComponent {
    @Output() textAdded = new EventEmitter<string>();

    textForm = new FormGroup({
        text: new FormControl('', Validators.required),
    });

    /** Section scope: live channels vs VOD (movies + series). */
    readonly importLive = signal(true);
    readonly importVod = signal(true);

    clearForm(): void {
        this.importLive.set(true);
        this.importVod.set(true);
        this.textForm.reset({
            text: '',
        });
    }
}
