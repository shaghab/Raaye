import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { Router, RouterLink } from '@angular/router';
import {
  AGE_BANDS,
  AUTHORING_TYPES,
  GENDERS,
  LIMITS,
  MEMBERSHIP_KINDS,
  WHATSAPP_LIMITS,
  type AgeBand,
  type AudienceDefinition,
  type AuthoringType,
  type ContactSummaryDto,
  type Gender,
  type GroupDto,
  type MembershipKind,
  type Page,
  type QuestionInput,
  type SurveyCreate,
  type SurveyDetailDto,
  type SurveyUpdate,
  type TagDto,
} from '@raaye/contracts';
import { ApiError, ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { describeSeconds, isoToLocal, localToIso } from '../../core/format';
import { NotifyService } from '../../core/notify.service';
import { SHARED } from '../../shared/ui';

interface OptionForm {
  id?: string;
  label: string;
  exclusive: boolean;
}

interface QuestionForm {
  id?: string;
  authoringType: AuthoringType;
  prompt: string;
  options: OptionForm[];
  minSelections: number;
  maxSelections: number;
  ratingMinLabel: string;
  ratingMaxLabel: string;
}

function emptyQuestion(type: AuthoringType = 'YES_NO'): QuestionForm {
  return { authoringType: type, prompt: '', options: [{ label: '', exclusive: false }, { label: '', exclusive: false }], minSelections: 1, maxSelections: 2, ratingMinLabel: '', ratingMaxLabel: '' };
}

/** Client-side mirror of the renderer routing so authors see how a question will be delivered. */
function rendererHint(question: QuestionForm): string {
  if (question.authoringType === 'MULTI_CHOICE') return 'WhatsApp Flow (multiple selection form)';
  if (question.authoringType === 'RATING') return 'List message (1-5)';
  if (question.authoringType === 'YES_NO') return 'Reply buttons';
  if (question.authoringType === 'YES_NO_INDIFFERENT') return 'Reply buttons';
  const count = question.options.length;
  const longLabel = question.options.some((option) => option.label.trim().length > WHATSAPP_LIMITS.replyButtons.titleChars);
  if (count <= WHATSAPP_LIMITS.replyButtons.max && !longLabel) return 'Reply buttons';
  if (count <= WHATSAPP_LIMITS.list.maxRows) return 'List message';
  return 'WhatsApp Flow (single choice)';
}

@Component({
  selector: 'rye-survey-editor',
  imports: [...SHARED, FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule, MatRadioModule, RouterLink],
  template: `
    <div class="page">
      <div class="page-header">
        <a mat-icon-button [routerLink]="id() ? ['/surveys', id()] : ['/surveys']" aria-label="Back"><mat-icon svgIcon="back" /></a>
        <h1>{{ id() ? 'Edit survey' : 'New survey' }}</h1>
      </div>
      <rye-state [loading]="loading()" [error]="error()" />
      @if (!loading() && !error()) {
        @if (locked()) {
          <div class="banner warn">This survey is {{ survey()?.state | label }}; its content is frozen. Unschedule it or clone it to make changes.</div>
        }
        <form (ngSubmit)="save()" class="stack">
          <mat-card>
            <mat-card-header><mat-card-title>Basics</mat-card-title></mat-card-header>
            <mat-card-content class="form-grid">
              <mat-form-field class="full"><mat-label>Internal title (staff only)</mat-label><input matInput name="internalTitle" [(ngModel)]="internalTitle" required maxlength="150" data-testid="survey-internal-title" /></mat-form-field>
              <mat-form-field class="full"><mat-label>Participant-facing title</mat-label><input matInput name="title" [(ngModel)]="title" required maxlength="120" data-testid="survey-title" /></mat-form-field>
              <mat-form-field class="full"><mat-label>Introduction (sent after Start survey)</mat-label><textarea matInput name="introduction" [(ngModel)]="introduction" rows="3" maxlength="1024" required data-testid="survey-intro"></textarea><mat-hint>English is required for this MVP; the content model is locale-ready.</mat-hint></mat-form-field>
            </mat-card-content>
          </mat-card>

          <mat-card>
            <mat-card-header><mat-card-title>Questions ({{ questions().length }} / {{ limits.questionsPerSurvey.max }})</mat-card-title></mat-card-header>
            <mat-card-content class="stack">
              @for (q of questions(); track q; let i = $index) {
                <div class="question">
                  <div class="row">
                    <strong>Question {{ i + 1 }}</strong>
                    <span class="chip info">{{ hint(q) }}</span>
                    <span class="spacer"></span>
                    <button mat-icon-button type="button" aria-label="Move up" [disabled]="i === 0" (click)="move(i, -1)"><mat-icon svgIcon="up" /></button>
                    <button mat-icon-button type="button" aria-label="Move down" [disabled]="i === questions().length - 1" (click)="move(i, 1)"><mat-icon svgIcon="down" /></button>
                    <button mat-icon-button type="button" aria-label="Remove question" [disabled]="questions().length <= 1" (click)="remove(i)"><mat-icon svgIcon="delete" /></button>
                  </div>
                  <div class="form-grid">
                    <mat-form-field>
                      <mat-label>Type</mat-label>
                      <mat-select [name]="'type' + i" [(ngModel)]="q.authoringType" (selectionChange)="typeChanged(q)" [attr.data-testid]="'question-type-' + i">
                        @for (type of types; track type) { <mat-option [value]="type">{{ type | label }}</mat-option> }
                      </mat-select>
                    </mat-form-field>
                    <mat-form-field class="full"><mat-label>Prompt</mat-label><textarea matInput [name]="'prompt' + i" [(ngModel)]="q.prompt" rows="2" maxlength="1024" required [attr.data-testid]="'question-prompt-' + i"></textarea></mat-form-field>
                    @if (q.authoringType === 'SINGLE_CHOICE' || q.authoringType === 'MULTI_CHOICE') {
                      <div class="full stack">
                        @for (o of q.options; track o; let j = $index) {
                          <div class="row">
                            <mat-form-field class="spacer"><mat-label>Option {{ j + 1 }}</mat-label><input matInput [name]="'opt' + i + '_' + j" [(ngModel)]="o.label" maxlength="100" required [attr.data-testid]="'question-' + i + '-option-' + j" /></mat-form-field>
                            @if (q.authoringType === 'MULTI_CHOICE') { <mat-checkbox [name]="'excl' + i + '_' + j" [(ngModel)]="o.exclusive">Exclusive (e.g. None of the above)</mat-checkbox> }
                            <button mat-icon-button type="button" aria-label="Remove option" [disabled]="q.options.length <= limits.optionsPerQuestion.min" (click)="removeOption(q, j)"><mat-icon svgIcon="close" /></button>
                          </div>
                        }
                        <div class="row">
                          <button mat-stroked-button type="button" [disabled]="q.options.length >= limits.optionsPerQuestion.max" (click)="addOption(q)"><mat-icon svgIcon="add" /> Add option</button>
                          <span class="small muted">{{ q.options.length }} / {{ limits.optionsPerQuestion.max }} options. Labels over {{ buttonChars }} characters switch to a list; more than {{ listRows }} options use a Flow.</span>
                        </div>
                      </div>
                    }
                    @if (q.authoringType === 'MULTI_CHOICE') {
                      <mat-form-field><mat-label>Minimum selections</mat-label><input matInput type="number" [name]="'min' + i" [(ngModel)]="q.minSelections" min="1" [max]="q.options.length" /></mat-form-field>
                      <mat-form-field><mat-label>Maximum selections</mat-label><input matInput type="number" [name]="'max' + i" [(ngModel)]="q.maxSelections" min="1" [max]="q.options.length" /></mat-form-field>
                    }
                    @if (q.authoringType === 'RATING') {
                      <mat-form-field><mat-label>Label for 1 (optional)</mat-label><input matInput [name]="'rmin' + i" [(ngModel)]="q.ratingMinLabel" maxlength="24" /></mat-form-field>
                      <mat-form-field><mat-label>Label for 5 (optional)</mat-label><input matInput [name]="'rmax' + i" [(ngModel)]="q.ratingMaxLabel" maxlength="24" /></mat-form-field>
                    }
                  </div>
                </div>
              }
              <div class="row">
                <button mat-stroked-button type="button" [disabled]="questions().length >= limits.questionsPerSurvey.max" (click)="addQuestion()" data-testid="add-question"><mat-icon svgIcon="add" /> Add question</button>
              </div>
            </mat-card-content>
          </mat-card>

          <mat-card>
            <mat-card-header><mat-card-title>Audience</mat-card-title><mat-card-subtitle>Membership is frozen when the survey is scheduled or launched; permission is rechecked before every send.</mat-card-subtitle></mat-card-header>
            <mat-card-content class="stack">
              <mat-radio-group name="audienceMode" [(ngModel)]="audienceMode" class="row">
                <mat-radio-button value="EVERYONE">Everyone with permission</mat-radio-button>
                <mat-radio-button value="SELECTED">Selected contacts</mat-radio-button>
                <mat-radio-button value="GROUPS_TAGS">Groups and tags</mat-radio-button>
                <mat-radio-button value="FILTERED">Demographic filter</mat-radio-button>
              </mat-radio-group>
              @if (audienceMode === 'SELECTED') {
                <div class="row">
                  <mat-form-field class="spacer"><mat-label>Search contacts</mat-label><input matInput name="contactSearch" [(ngModel)]="contactSearch" (keyup.enter)="searchContacts()" /></mat-form-field>
                  <button mat-stroked-button type="button" (click)="searchContacts()">Search</button>
                </div>
                <div class="row">
                  @for (c of contactResults(); track c.id) {
                    <button mat-stroked-button type="button" [disabled]="isSelected(c.id)" (click)="addContact(c)">{{ c.name }} · {{ c.phoneE164 }}</button>
                  }
                </div>
                <div class="row">
                  @for (c of selectedContacts(); track c.id) {
                    <span class="chip">{{ c.name }} <button type="button" class="chip-x" aria-label="Remove" (click)="removeContact(c.id)">×</button></span>
                  }
                  @if (!selectedContacts().length) { <span class="muted small">No contacts selected.</span> }
                </div>
              }
              @if (audienceMode === 'GROUPS_TAGS') {
                <div class="form-grid">
                  <mat-form-field><mat-label>Groups</mat-label><mat-select name="groupIds" [(ngModel)]="groupIds" multiple>@for (g of groups(); track g.id) { <mat-option [value]="g.id">{{ g.name }} ({{ g.contactCount }})</mat-option> }</mat-select></mat-form-field>
                  <mat-form-field><mat-label>Tags</mat-label><mat-select name="tagIds" [(ngModel)]="tagIds" multiple>@for (t of tags(); track t.id) { <mat-option [value]="t.id">{{ t.name }} ({{ t.contactCount }})</mat-option> }</mat-select></mat-form-field>
                  <mat-form-field><mat-label>Match</mat-label><mat-select name="groupTagMatch" [(ngModel)]="groupTagMatch"><mat-option value="ANY">Any selected group or tag</mat-option><mat-option value="ALL">All selected groups and tags</mat-option></mat-select></mat-form-field>
                </div>
              }
              @if (audienceMode === 'FILTERED') {
                <div class="form-grid">
                  <mat-form-field><mat-label>Cities (comma separated)</mat-label><input matInput name="fCity" [(ngModel)]="filterCity" /></mat-form-field>
                  <mat-form-field><mat-label>Districts (comma separated)</mat-label><input matInput name="fDistrict" [(ngModel)]="filterDistrict" /></mat-form-field>
                  <mat-form-field><mat-label>Occupations (comma separated)</mat-label><input matInput name="fOccupation" [(ngModel)]="filterOccupation" /></mat-form-field>
                  <mat-form-field><mat-label>Gender</mat-label><mat-select name="fGender" [(ngModel)]="filterGender" multiple>@for (g of genders; track g) { <mat-option [value]="g">{{ g | label }}</mat-option> }</mat-select></mat-form-field>
                  <mat-form-field><mat-label>Age band</mat-label><mat-select name="fAge" [(ngModel)]="filterAgeBand" multiple>@for (a of ageBands; track a) { <mat-option [value]="a">{{ a | label }}</mat-option> }</mat-select></mat-form-field>
                  <mat-form-field><mat-label>Membership</mat-label><mat-select name="fMembership" [(ngModel)]="filterMembership" multiple>@for (m of memberships; track m) { <mat-option [value]="m">{{ m | label }}</mat-option> }</mat-select></mat-form-field>
                </div>
                <p class="small muted">Contacts with unknown values for a filtered dimension are excluded. Leave a field empty to ignore it.</p>
              }
            </mat-card-content>
          </mat-card>

          <mat-card>
            <mat-card-header><mat-card-title>Timing</mat-card-title></mat-card-header>
            <mat-card-content class="form-grid">
              <mat-form-field>
                <mat-label>Planned opening (optional, {{ auth.timezone() }})</mat-label>
                <input matInput type="datetime-local" name="scheduledOpensAt" [(ngModel)]="scheduledOpensAt" />
                <mat-hint>Used as the default when you schedule from the survey page.</mat-hint>
              </mat-form-field>
              @if (auth.hasRole('ADMIN')) {
                <mat-form-field><mat-label>Duration (hours)</mat-label><input matInput type="number" name="durationHours" [(ngModel)]="durationHours" min="1" max="720" /><mat-hint>Default {{ defaultDuration() }}. Closing is measured from the opening time.</mat-hint></mat-form-field>
                <mat-form-field><mat-label>Answer edit window (seconds)</mat-label><input matInput type="number" name="editWindow" [(ngModel)]="editWindowSeconds" min="0" max="3600" /><mat-hint>0 disables edits. Starts at the first accepted answer.</mat-hint></mat-form-field>
                <mat-form-field><mat-label>Explicit closing time (optional)</mat-label><input matInput type="datetime-local" name="explicitClosesAt" [(ngModel)]="explicitClosesAt" /></mat-form-field>
              } @else {
                <p class="full muted small">Duration and edit-window defaults are set by an Admin ({{ defaultDuration() }} / {{ defaultEditWindow() }}).</p>
              }
            </mat-card-content>
          </mat-card>

          @if (fieldErrors().length) {
            <ul class="danger" role="alert">
              @for (fe of fieldErrors(); track fe.path) { <li>{{ fe.path }}: {{ fe.message }}</li> }
            </ul>
          }
          <div class="row">
            <button mat-flat-button type="submit" [disabled]="saving() || locked()" data-testid="survey-save">{{ id() ? 'Save changes' : 'Create draft' }}</button>
            <a mat-button [routerLink]="id() ? ['/surveys', id()] : ['/surveys']">Cancel</a>
          </div>
        </form>
      }
    </div>
  `,
  styles: ['.question { border: 1px solid var(--mat-sys-outline-variant); border-radius: 8px; padding: 12px; } .chip-x { border: none; background: none; cursor: pointer; font-size: 14px; }'],
})
export class SurveyEditorComponent {
  readonly id = input<string | undefined>(undefined);
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly router = inject(Router);
  readonly limits = LIMITS;
  readonly buttonChars = WHATSAPP_LIMITS.replyButtons.titleChars;
  readonly listRows = WHATSAPP_LIMITS.list.maxRows;
  readonly types = AUTHORING_TYPES;
  readonly genders = GENDERS;
  readonly ageBands = AGE_BANDS;
  readonly memberships = MEMBERSHIP_KINDS;
  readonly survey = signal<SurveyDetailDto | null>(null);
  readonly locked = computed(() => {
    const state = this.survey()?.state;
    return state !== undefined && state !== 'DRAFT';
  });
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly fieldErrors = signal<{ path: string; message: string }[]>([]);
  readonly questions = signal<QuestionForm[]>([emptyQuestion()]);
  readonly groups = signal<GroupDto[]>([]);
  readonly tags = signal<TagDto[]>([]);
  readonly contactResults = signal<ContactSummaryDto[]>([]);
  readonly selectedContacts = signal<{ id: string; name: string }[]>([]);
  internalTitle = '';
  title = '';
  introduction = '';
  audienceMode: AudienceDefinition['mode'] = 'EVERYONE';
  contactSearch = '';
  groupIds: string[] = [];
  tagIds: string[] = [];
  groupTagMatch: 'ANY' | 'ALL' = 'ANY';
  filterCity = '';
  filterDistrict = '';
  filterOccupation = '';
  filterGender: string[] = [];
  filterAgeBand: string[] = [];
  filterMembership: string[] = [];
  scheduledOpensAt = '';
  explicitClosesAt = '';
  durationHours = 48;
  editWindowSeconds = 120;
  private orgDefaults: { duration: number; editWindow: number } = { duration: LIMITS.durationSeconds.default, editWindow: LIMITS.editWindowSeconds.default };

  constructor() {
    queueMicrotask(() => void this.init());
  }

  hint(question: QuestionForm): string {
    return rendererHint(question);
  }

  defaultDuration(): string {
    return describeSeconds(this.orgDefaults.duration);
  }

  defaultEditWindow(): string {
    return describeSeconds(this.orgDefaults.editWindow);
  }

  private async init(): Promise<void> {
    this.loading.set(true);
    try {
      const [groups, tags, org] = await Promise.all([this.api.get<GroupDto[]>('/groups'), this.api.get<TagDto[]>('/tags'), this.api.get<{ defaultDurationSeconds: number; defaultEditWindowSeconds: number }>('/organization')]);
      this.groups.set(groups);
      this.tags.set(tags);
      this.orgDefaults = { duration: org.defaultDurationSeconds, editWindow: org.defaultEditWindowSeconds };
      this.durationHours = Math.round(org.defaultDurationSeconds / 3600);
      this.editWindowSeconds = org.defaultEditWindowSeconds;
      const id = this.id();
      if (id) {
        const survey = await this.api.get<SurveyDetailDto>(`/surveys/${id}`);
        this.survey.set(survey);
        this.populate(survey);
      }
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    } finally {
      this.loading.set(false);
    }
  }

  private populate(survey: SurveyDetailDto): void {
    const revision = survey.revision;
    this.internalTitle = survey.internalTitle;
    this.title = revision.title['en'] ?? '';
    this.introduction = revision.introduction['en'] ?? '';
    this.questions.set(
      revision.questions.length
        ? revision.questions.map((question) => ({
            id: question.id,
            authoringType: question.authoringType,
            prompt: question.prompt['en'] ?? '',
            options: question.authoringType === 'SINGLE_CHOICE' || question.authoringType === 'MULTI_CHOICE' ? question.options.map((option) => ({ id: option.id, label: option.label['en'] ?? '', exclusive: option.exclusive })) : [{ label: '', exclusive: false }, { label: '', exclusive: false }],
            minSelections: question.minSelections ?? 1,
            maxSelections: question.maxSelections ?? question.options.length,
            ratingMinLabel: question.ratingMinLabel?.['en'] ?? '',
            ratingMaxLabel: question.ratingMaxLabel?.['en'] ?? '',
          }))
        : [emptyQuestion()],
    );
    const audience = revision.audience;
    this.audienceMode = audience.mode;
    this.groupIds = audience.groupIds ?? [];
    this.tagIds = audience.tagIds ?? [];
    this.groupTagMatch = audience.groupTagMatch ?? 'ANY';
    this.filterCity = audience.filters?.city?.join(', ') ?? '';
    this.filterDistrict = audience.filters?.district?.join(', ') ?? '';
    this.filterOccupation = audience.filters?.occupation?.join(', ') ?? '';
    this.filterGender = audience.filters?.gender ?? [];
    this.filterAgeBand = audience.filters?.ageBand ?? [];
    this.filterMembership = audience.filters?.membership ?? [];
    this.scheduledOpensAt = isoToLocal(revision.scheduledOpensAt, this.auth.timezone());
    this.explicitClosesAt = isoToLocal(revision.explicitClosesAt, this.auth.timezone());
    this.durationHours = Math.round(revision.durationSeconds / 3600);
    this.editWindowSeconds = revision.editWindowSeconds;
    if (audience.contactIds?.length) {
      void Promise.all(audience.contactIds.map((contactId) => this.api.get<ContactSummaryDto>(`/contacts/${contactId}`).catch(() => null))).then((contacts) => {
        this.selectedContacts.set(contacts.flatMap((contact) => (contact ? [{ id: contact.id, name: contact.name }] : [])));
      });
    }
  }

  addQuestion(): void {
    this.questions.update((list) => [...list, emptyQuestion()]);
  }

  remove(index: number): void {
    this.questions.update((list) => list.filter((_, i) => i !== index));
  }

  move(index: number, delta: number): void {
    this.questions.update((list) => {
      const next = [...list];
      const target = index + delta;
      if (target < 0 || target >= next.length) return list;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  typeChanged(question: QuestionForm): void {
    if ((question.authoringType === 'SINGLE_CHOICE' || question.authoringType === 'MULTI_CHOICE') && question.options.length < 2) question.options = [{ label: '', exclusive: false }, { label: '', exclusive: false }];
    question.maxSelections = Math.min(question.maxSelections, question.options.length) || question.options.length;
  }

  addOption(question: QuestionForm): void {
    question.options = [...question.options, { label: '', exclusive: false }];
    if (question.maxSelections === question.options.length - 1) question.maxSelections = question.options.length;
  }

  removeOption(question: QuestionForm, index: number): void {
    question.options = question.options.filter((_, i) => i !== index);
    question.maxSelections = Math.min(question.maxSelections, question.options.length);
  }

  async searchContacts(): Promise<void> {
    try {
      const page = await this.api.get<Page<ContactSummaryDto>>('/contacts', { search: this.contactSearch, limit: 10 });
      this.contactResults.set(page.items);
    } catch (error) {
      this.notify.error(error);
    }
  }

  isSelected(id: string): boolean {
    return this.selectedContacts().some((contact) => contact.id === id);
  }

  addContact(contact: ContactSummaryDto): void {
    if (!this.isSelected(contact.id)) this.selectedContacts.update((list) => [...list, { id: contact.id, name: contact.name }]);
  }

  removeContact(id: string): void {
    this.selectedContacts.update((list) => list.filter((contact) => contact.id !== id));
  }

  private list(value: string): string[] | undefined {
    const items = value.split(',').map((item) => item.trim()).filter(Boolean);
    return items.length ? items : undefined;
  }

  private buildAudience(): AudienceDefinition {
    const base: AudienceDefinition = { mode: this.audienceMode, groupTagMatch: this.groupTagMatch };
    if (this.audienceMode === 'SELECTED') base.contactIds = this.selectedContacts().map((contact) => contact.id);
    if (this.audienceMode === 'GROUPS_TAGS') {
      base.groupIds = this.groupIds;
      base.tagIds = this.tagIds;
    }
    if (this.audienceMode === 'FILTERED') {
      base.filters = {
        city: this.list(this.filterCity),
        district: this.list(this.filterDistrict),
        occupation: this.list(this.filterOccupation),
        gender: this.filterGender.length ? (this.filterGender as Gender[]) : undefined,
        ageBand: this.filterAgeBand.length ? (this.filterAgeBand as AgeBand[]) : undefined,
        membership: this.filterMembership.length ? (this.filterMembership as MembershipKind[]) : undefined,
      };
    }
    return base;
  }

  private buildQuestions(): QuestionInput[] {
    return this.questions().map((question) => {
      const base: QuestionInput = { id: question.id, authoringType: question.authoringType, prompt: { en: question.prompt.trim() } };
      if (question.authoringType === 'SINGLE_CHOICE' || question.authoringType === 'MULTI_CHOICE') {
        base.options = question.options.map((option) => ({ id: option.id, label: { en: option.label.trim() }, exclusive: question.authoringType === 'MULTI_CHOICE' ? option.exclusive : undefined }));
      }
      if (question.authoringType === 'MULTI_CHOICE') {
        base.minSelections = Number(question.minSelections);
        base.maxSelections = Number(question.maxSelections);
      }
      if (question.authoringType === 'RATING') {
        if (question.ratingMinLabel.trim()) base.ratingMinLabel = { en: question.ratingMinLabel.trim() };
        if (question.ratingMaxLabel.trim()) base.ratingMaxLabel = { en: question.ratingMaxLabel.trim() };
      }
      return base;
    });
  }

  async save(): Promise<void> {
    this.saving.set(true);
    this.fieldErrors.set([]);
    const zone = this.auth.timezone();
    const body: SurveyCreate = {
      internalTitle: this.internalTitle.trim(),
      title: { en: this.title.trim() },
      introduction: { en: this.introduction.trim() },
      locale: 'en',
      questions: this.buildQuestions(),
      audience: this.buildAudience(),
      scheduledOpensAt: localToIso(this.scheduledOpensAt, zone),
    };
    if (this.auth.hasRole('ADMIN')) {
      body.durationSeconds = Math.round(Number(this.durationHours) * 3600);
      body.editWindowSeconds = Number(this.editWindowSeconds);
      body.explicitClosesAt = localToIso(this.explicitClosesAt, zone);
    }
    try {
      const id = this.id();
      const saved = id ? await this.api.patch<SurveyDetailDto>(`/surveys/${id}`, body satisfies SurveyUpdate) : await this.api.post<SurveyDetailDto>('/surveys', body);
      this.notify.success(id ? 'Survey saved' : 'Draft created');
      await this.router.navigate(['/surveys', saved.id]);
    } catch (error) {
      const apiError = this.notify.error(error);
      this.fieldErrors.set(apiError.fieldErrors);
    } finally {
      this.saving.set(false);
    }
  }
}
