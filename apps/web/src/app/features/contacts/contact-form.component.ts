import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router, RouterLink } from '@angular/router';
import { AGE_BANDS, GENDERS, MEMBERSHIP_KINDS, type ContactCreate, type ContactDetailDto, type ContactUpdate, type GroupDto, type TagDto } from '@raaye/contracts';
import { ApiError, ApiService } from '../../core/api.service';
import { NotifyService } from '../../core/notify.service';
import { SHARED } from '../../shared/ui';

@Component({
  selector: 'rye-contact-form',
  imports: [...SHARED, FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule, RouterLink],
  template: `
    <div class="page">
      <div class="page-header">
        <a mat-icon-button [routerLink]="id() ? ['/contacts', id()] : ['/contacts']" aria-label="Back"><mat-icon svgIcon="back" /></a>
        <h1>{{ id() ? 'Edit contact' : 'Add contact' }}</h1>
      </div>
      <rye-state [loading]="loading()" [error]="error()" />
      @if (!loading()) {
        <mat-card>
          <mat-card-content>
            <form (ngSubmit)="save()" class="form-grid">
              <mat-form-field>
                <mat-label>Name</mat-label>
                <input matInput name="name" [(ngModel)]="model.name" required maxlength="150" data-testid="contact-name" />
              </mat-form-field>
              <mat-form-field>
                <mat-label>Phone (E.164 or national)</mat-label>
                <input matInput name="phone" [(ngModel)]="model.phone" required placeholder="+92 300 1234567" data-testid="contact-phone" />
                <mat-hint>Numbers are normalized; the country below applies to national formats.</mat-hint>
              </mat-form-field>
              <mat-form-field>
                <mat-label>Default country</mat-label>
                <input matInput name="defaultCountry" [(ngModel)]="model.defaultCountry" maxlength="2" />
              </mat-form-field>
              <mat-form-field>
                <mat-label>City</mat-label>
                <input matInput name="city" [(ngModel)]="model.city" maxlength="100" />
              </mat-form-field>
              <mat-form-field>
                <mat-label>District</mat-label>
                <input matInput name="district" [(ngModel)]="model.district" maxlength="100" />
              </mat-form-field>
              <mat-form-field>
                <mat-label>Gender</mat-label>
                <mat-select name="gender" [(ngModel)]="model.gender">
                  <mat-option [value]="null">Not provided</mat-option>
                  @for (gender of genders; track gender) { <mat-option [value]="gender">{{ gender | label }}</mat-option> }
                </mat-select>
              </mat-form-field>
              <mat-form-field>
                <mat-label>Age band</mat-label>
                <mat-select name="ageBand" [(ngModel)]="model.ageBand">
                  <mat-option [value]="null">Not provided</mat-option>
                  @for (band of ageBands; track band) { <mat-option [value]="band">{{ band | label }}</mat-option> }
                </mat-select>
              </mat-form-field>
              <mat-form-field>
                <mat-label>Occupation</mat-label>
                <input matInput name="occupation" [(ngModel)]="model.occupation" maxlength="120" />
              </mat-form-field>
              <mat-form-field>
                <mat-label>Membership (organization-verified)</mat-label>
                <mat-select name="membership" [(ngModel)]="model.membership">
                  @for (kind of memberships; track kind) { <mat-option [value]="kind">{{ kind | label }}</mat-option> }
                </mat-select>
              </mat-form-field>
              <mat-form-field>
                <mat-label>Groups</mat-label>
                <mat-select name="groupIds" [(ngModel)]="model.groupIds" multiple>
                  @for (group of groups(); track group.id) { <mat-option [value]="group.id">{{ group.name }}</mat-option> }
                </mat-select>
              </mat-form-field>
              <mat-form-field>
                <mat-label>Tags</mat-label>
                <mat-select name="tagIds" [(ngModel)]="model.tagIds" multiple>
                  @for (tag of tags(); track tag.id) { <mat-option [value]="tag.id">{{ tag.name }}</mat-option> }
                </mat-select>
              </mat-form-field>
              @if (id() && original && original.phoneE164 !== model.phone) {
                <div class="full banner warn">
                  <mat-checkbox name="confirmPhoneChange" [(ngModel)]="confirmPhoneChange">I confirm the phone number changed. Existing consent evidence applies to the old number and is reset; record new evidence afterwards.</mat-checkbox>
                </div>
              }
              @if (fieldErrors().length) {
                <ul class="full danger" role="alert">
                  @for (fieldError of fieldErrors(); track fieldError.path) { <li>{{ fieldError.path }}: {{ fieldError.message }}</li> }
                </ul>
              }
              <div class="full row">
                <button mat-flat-button type="submit" [disabled]="saving()" data-testid="contact-save">{{ id() ? 'Save changes' : 'Create contact' }}</button>
                <a mat-button [routerLink]="id() ? ['/contacts', id()] : ['/contacts']">Cancel</a>
              </div>
            </form>
          </mat-card-content>
        </mat-card>
        @if (!id()) {
          <p class="small muted">Creating a contact does not record consent. Record consent evidence on the contact page before inviting them.</p>
        }
      }
    </div>
  `,
})
export class ContactFormComponent {
  readonly id = input<string | undefined>(undefined);
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly router = inject(Router);
  readonly genders = GENDERS;
  readonly ageBands = AGE_BANDS;
  readonly memberships = MEMBERSHIP_KINDS;
  readonly groups = signal<GroupDto[]>([]);
  readonly tags = signal<TagDto[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly fieldErrors = signal<{ path: string; message: string }[]>([]);
  original: ContactDetailDto | null = null;
  confirmPhoneChange = false;
  model: { name: string; phone: string; defaultCountry: string; city: string; district: string; gender: string | null; ageBand: string | null; occupation: string; membership: string; groupIds: string[]; tagIds: string[] } = {
    name: '',
    phone: '',
    defaultCountry: 'PK',
    city: '',
    district: '',
    gender: null,
    ageBand: null,
    occupation: '',
    membership: 'UNKNOWN',
    groupIds: [],
    tagIds: [],
  };

  constructor() {
    queueMicrotask(() => void this.init());
  }

  private async init(): Promise<void> {
    this.loading.set(true);
    try {
      const [groups, tags] = await Promise.all([this.api.get<GroupDto[]>('/groups'), this.api.get<TagDto[]>('/tags')]);
      this.groups.set(groups);
      this.tags.set(tags);
      const id = this.id();
      if (id) {
        const contact = await this.api.get<ContactDetailDto>(`/contacts/${id}`);
        this.original = contact;
        this.model = {
          name: contact.name,
          phone: contact.phoneE164,
          defaultCountry: 'PK',
          city: contact.city ?? '',
          district: contact.district ?? '',
          gender: contact.gender,
          ageBand: contact.ageBand,
          occupation: contact.occupation ?? '',
          membership: contact.membership,
          groupIds: contact.groups.map((group) => group.id),
          tagIds: contact.tags.map((tag) => tag.id),
        };
      }
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    } finally {
      this.loading.set(false);
    }
  }

  async save(): Promise<void> {
    this.saving.set(true);
    this.fieldErrors.set([]);
    const base = {
      name: this.model.name.trim(),
      phone: this.model.phone.trim(),
      defaultCountry: this.model.defaultCountry.trim().toUpperCase() || 'PK',
      city: this.model.city.trim() || null,
      district: this.model.district.trim() || null,
      gender: (this.model.gender as ContactCreate['gender']) ?? null,
      ageBand: (this.model.ageBand as ContactCreate['ageBand']) ?? null,
      occupation: this.model.occupation.trim() || null,
      membership: this.model.membership as ContactCreate['membership'],
      groupIds: this.model.groupIds,
      tagIds: this.model.tagIds,
    };
    try {
      const id = this.id();
      if (id) {
        const body: ContactUpdate = { ...base, confirmPhoneChange: this.confirmPhoneChange || undefined };
        const saved = await this.api.patch<ContactDetailDto>(`/contacts/${id}`, body);
        this.notify.success('Contact updated');
        await this.router.navigate(['/contacts', saved.id]);
      } else {
        const saved = await this.api.post<ContactDetailDto>('/contacts', base satisfies ContactCreate);
        this.notify.success('Contact created');
        await this.router.navigate(['/contacts', saved.id]);
      }
    } catch (error) {
      const apiError = this.notify.error(error);
      this.fieldErrors.set(apiError.fieldErrors);
    } finally {
      this.saving.set(false);
    }
  }
}
