import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import type { ConsentEventCreate, ConsentScope, ContactDetailDto } from '@raaye/contracts';
import { AuthService } from '../../core/auth.service';
import { localToIso } from '../../core/format';

export interface ConsentDialogData {
  contact: ContactDetailDto;
}

/** Staff-recorded consent evidence. Imported data or a reply is never treated as consent here. */
@Component({
  selector: 'rye-consent-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatCheckboxModule, MatRadioModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>Record consent evidence</h2>
    <mat-dialog-content class="stack">
      <p class="muted small">Record what the person actually agreed to and where that evidence lives. Withdrawals apply immediately to queued sends.</p>
      <div>
        <strong>Scopes</strong><br />
        <mat-checkbox [(ngModel)]="invitations">Survey invitations</mat-checkbox>
        <mat-checkbox [(ngModel)]="results">Result sharing</mat-checkbox>
      </div>
      <mat-radio-group [(ngModel)]="type">
        <mat-radio-button value="GRANTED">Granted</mat-radio-button>
        <mat-radio-button value="WITHDRAWN">Withdrawn</mat-radio-button>
      </mat-radio-group>
      <mat-form-field>
        <mat-label>Evidence date and time</mat-label>
        <input matInput type="datetime-local" [(ngModel)]="evidenceAt" required />
      </mat-form-field>
      <mat-form-field>
        <mat-label>Evidence reference (form id, document, call note…)</mat-label>
        <input matInput [(ngModel)]="evidenceReference" required maxlength="300" />
      </mat-form-field>
      <mat-form-field>
        <mat-label>Consent wording version</mat-label>
        <input matInput [(ngModel)]="wordingVersion" maxlength="50" placeholder="e.g. v1-2026-09" />
      </mat-form-field>
      <mat-form-field>
        <mat-label>Note</mat-label>
        <textarea matInput [(ngModel)]="note" maxlength="500" rows="2"></textarea>
      </mat-form-field>
      @if (type === 'GRANTED' && previouslyWithdrawn()) {
        <mat-checkbox [(ngModel)]="reviewedNewEvidence">I reviewed new evidence that this person re-granted permission after withdrawing it.</mat-checkbox>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" (click)="ref.close(null)">Cancel</button>
      <button mat-flat-button type="button" [disabled]="!valid()" (click)="submit()">Save</button>
    </mat-dialog-actions>
  `,
})
export class ConsentDialogComponent {
  readonly ref = inject<MatDialogRef<ConsentDialogComponent, ConsentEventCreate | null>>(MatDialogRef);
  readonly data = inject<ConsentDialogData>(MAT_DIALOG_DATA);
  private readonly auth = inject(AuthService);
  invitations = true;
  results = false;
  type: 'GRANTED' | 'WITHDRAWN' = 'GRANTED';
  evidenceAt = '';
  evidenceReference = '';
  wordingVersion = '';
  note = '';
  reviewedNewEvidence = false;

  previouslyWithdrawn(): boolean {
    const consent = this.data.contact.consent;
    return (this.invitations && consent.invitations === 'WITHDRAWN') || (this.results && consent.results === 'WITHDRAWN');
  }

  valid(): boolean {
    const scopes = this.scopes();
    if (!scopes.length || !this.evidenceAt || !this.evidenceReference.trim()) return false;
    if (this.type === 'GRANTED' && this.previouslyWithdrawn() && !this.reviewedNewEvidence) return false;
    return true;
  }

  private scopes(): ConsentScope[] {
    const scopes: ConsentScope[] = [];
    if (this.invitations) scopes.push('SURVEY_INVITATIONS');
    if (this.results) scopes.push('SURVEY_RESULTS');
    return scopes;
  }

  submit(): void {
    const evidenceAt = localToIso(this.evidenceAt, this.auth.timezone());
    if (!evidenceAt) return;
    this.ref.close({
      scopes: this.scopes(),
      type: this.type,
      evidenceAt,
      evidenceReference: this.evidenceReference.trim(),
      wordingVersion: this.wordingVersion.trim() || undefined,
      note: this.note.trim() || undefined,
      reviewedNewEvidence: this.reviewedNewEvidence || undefined,
    });
  }
}
