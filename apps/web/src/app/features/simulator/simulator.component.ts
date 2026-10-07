import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { AGE_BANDS, GENDERS, MEMBERSHIP_KINDS, type ContactSummaryDto, type Page, type SimulatorConversationMessageDto, type SimulatorStateDto } from '@raaye/contracts';
import { ApiError, ApiService } from '../../core/api.service';
import { NotifyService } from '../../core/notify.service';
import { SHARED } from '../../shared/ui';

type SimMessage = SimulatorConversationMessageDto;

/**
 * Development-only participant simulator. Every action goes through the same inbound pipeline
 * as a real webhook (text, button/list taps, Flow submissions, delivery callbacks).
 */
@Component({
  selector: 'rye-simulator',
  imports: [...SHARED, FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>WhatsApp simulator</h1>
        <rye-chip text="DEVELOPMENT ONLY · MOCK PROVIDER" tone="warn" />
        <div class="actions">
          <button mat-stroked-button type="button" (click)="drain()" data-testid="sim-drain"><mat-icon svgIcon="play" /> Process queued jobs</button>
          <button mat-stroked-button type="button" (click)="refresh()"><mat-icon svgIcon="refresh" /> Refresh</button>
        </div>
      </div>
      <rye-state [error]="error()" [retry]="refresh" />
      @if (state(); as s) {
        <div class="banner">
          Simulated clock: <strong>{{ s.now | dt }}</strong> (offset {{ s.clockOffsetSeconds }}s) · webhook app key <code class="mono">{{ s.connectionAppKey }}</code>
          <span class="row" style="margin-top: 8px">
            <button mat-stroked-button type="button" (click)="clock(60)">+1 min</button>
            <button mat-stroked-button type="button" (click)="clock(121)" data-testid="sim-clock-121">+121 s</button>
            <button mat-stroked-button type="button" (click)="clock(3600)">+1 hour</button>
            <button mat-stroked-button type="button" (click)="clock(25 * 3600)">+25 hours</button>
            <button mat-stroked-button type="button" (click)="clock(49 * 3600)">+49 hours</button>
            <button mat-button type="button" (click)="resetClock()">Reset clock</button>
          </span>
          <span class="row" style="margin-top: 8px">
            <mat-form-field class="compact"><mat-label>Next send outcome</mat-label>
              <mat-select [(ngModel)]="nextOutcome" (selectionChange)="faults()"><mat-option value="">Normal</mat-option><mat-option value="FAILED_TEMPORARY">Temporary failure</mat-option><mat-option value="FAILED_PERMANENT">Permanent failure</mat-option><mat-option value="TIMEOUT">Timeout (unknown outcome)</mat-option></mat-select>
            </mat-form-field>
            <mat-checkbox [(ngModel)]="expireWindow" (change)="faults()">Treat selected contact's service window as expired</mat-checkbox>
            <mat-checkbox [(ngModel)]="failContact" (change)="faults()">Fail every send to the selected contact</mat-checkbox>
            <mat-checkbox [(ngModel)]="timeoutContact" (change)="faults()">Time out every send to the selected contact (unknown outcome)</mat-checkbox>
          </span>
        </div>
      }
      <div class="sim-layout">
        <mat-card class="contacts">
          <mat-card-header><mat-card-title>Participants</mat-card-title></mat-card-header>
          <mat-card-content>
            <mat-form-field style="width: 100%"><mat-label>Search</mat-label><input matInput [(ngModel)]="search" (keyup.enter)="loadContacts()" /></mat-form-field>
            <div class="contact-list">
              @for (c of contacts(); track c.id) {
                <button type="button" class="contact" [class.selected]="c.id === selectedId()" (click)="select(c)" [attr.data-testid]="'sim-contact-' + c.phoneE164">
                  <strong>{{ c.name }}</strong><br /><span class="mono small">{{ c.phoneE164 }}</span>
                </button>
              }
            </div>
            <div class="stack" style="margin-top: 12px">
              <strong class="small">Unknown sender (enrollment)</strong>
              <mat-form-field><mat-label>Phone</mat-label><input matInput [(ngModel)]="newPhone" placeholder="+92300..." /></mat-form-field>
              <mat-form-field><mat-label>Profile name</mat-label><input matInput [(ngModel)]="newName" /></mat-form-field>
              <button mat-stroked-button type="button" [disabled]="!newPhone" (click)="sendUnknown()">Send "HI" as unknown number</button>
            </div>
          </mat-card-content>
        </mat-card>
        <mat-card class="chat">
          <mat-card-header><mat-card-title>{{ selected()?.name ?? 'Select a participant' }}</mat-card-title>@if (selected(); as c) { <mat-card-subtitle>{{ c.phoneE164 }} · invitations {{ c.consent.invitations | label }}</mat-card-subtitle> }</mat-card-header>
          <mat-card-content>
            <div class="wa-chat" data-testid="sim-chat">
              @if (!messages().length) { <p class="muted">No messages yet. Launch a survey or send a test to this contact, then process queued jobs.</p> }
              @for (m of messages(); track m.id) {
                <div class="wa-bubble" [class.out]="m.direction === 'OUTBOUND'" [class.in]="m.direction === 'INBOUND'" [attr.data-kind]="m.kind">
                  <div>{{ m.text }}</div>
                  @if (m.direction === 'OUTBOUND' && m.controls.length) {
                    <div class="wa-controls">
                      @for (c of m.controls; track c.id) {
                        <button mat-stroked-button type="button" (click)="tap(m, c.id)" [attr.data-testid]="'sim-control-' + c.label">{{ c.label }}</button>
                      }
                    </div>
                  }
                  @if (m.direction === 'OUTBOUND' && m.flow; as f) {
                    <div class="flow-form">
                      <div class="small"><strong>Flow:</strong> {{ f.purpose | label }}</div>
                      @if (f.purpose !== 'PROFILE') {
                        @for (o of f.options; track o.id) {
                          <label class="small"><input [type]="f.purpose === 'MULTI_CHOICE' ? 'checkbox' : 'radio'" [name]="'flow-' + m.id" [checked]="isChecked(m.id, o.id)" (change)="toggle(m, o.id, $any($event.target).checked)" /> {{ o.label }} @if (o.exclusive) { <em>(exclusive)</em> }</label>
                        }
                        @if (f.minSelections !== null) { <div class="small muted">Select {{ f.minSelections }}–{{ f.maxSelections }}</div> }
                      } @else {
                        <div class="form-grid">
                          <mat-form-field><mat-label>City</mat-label><input matInput [(ngModel)]="profile.city" /></mat-form-field>
                          <mat-form-field><mat-label>District</mat-label><input matInput [(ngModel)]="profile.district" /></mat-form-field>
                          <mat-form-field><mat-label>Gender</mat-label><mat-select [(ngModel)]="profile.gender"><mat-option value="">—</mat-option>@for (g of genders; track g) { <mat-option [value]="g">{{ g | label }}</mat-option> }</mat-select></mat-form-field>
                          <mat-form-field><mat-label>Age band</mat-label><mat-select [(ngModel)]="profile.ageBand"><mat-option value="">—</mat-option>@for (a of ageBands; track a) { <mat-option [value]="a">{{ a | label }}</mat-option> }</mat-select></mat-form-field>
                          <mat-form-field><mat-label>Occupation</mat-label><input matInput [(ngModel)]="profile.occupation" /></mat-form-field>
                          <mat-form-field><mat-label>Membership</mat-label><mat-select [(ngModel)]="profile.membership"><mat-option value="">—</mat-option>@for (k of memberships; track k) { <mat-option [value]="k">{{ k | label }}</mat-option> }</mat-select></mat-form-field>
                        </div>
                      }
                      <button mat-flat-button type="button" (click)="submitFlow(m)" [attr.data-testid]="'sim-flow-submit-' + m.id">Submit form</button>
                    </div>
                  }
                  <div class="meta">
                    <span>{{ m.createdAt | dt }}</span>
                    @if (m.direction === 'OUTBOUND') {
                      <span>{{ m.kind | label }}</span>
                      <span>{{ m.deliveryState | label }}</span>
                      @if (m.isTest) { <span>TEST</span> }
                      @if (m.templateName) { <span>template {{ m.templateName }}</span> }
                      @if (m.suppressionReason) { <span class="danger">suppressed: {{ m.suppressionReason | label }}</span> }
                      @if (m.errorCode) { <span class="danger">{{ m.errorCode }}</span> }
                      @if (m.deliveryState === 'SENT' || m.deliveryState === 'ACCEPTED') { <button type="button" class="linkish" (click)="status(m, 'DELIVERED')">mark delivered</button> }
                      @if (m.deliveryState === 'DELIVERED') { <button type="button" class="linkish" (click)="status(m, 'READ')">mark read</button> <button type="button" class="linkish" (click)="status(m, 'DELIVERED', true)">duplicate callback</button> }
                      @if (m.deliveryState === 'ACCEPTED' || m.deliveryState === 'SENT') { <button type="button" class="linkish danger" (click)="status(m, 'FAILED')">fail</button> }
                    }
                  </div>
                </div>
              }
            </div>
            @if (selected()) {
              <form class="row" (ngSubmit)="sendText()" style="margin-top: 12px">
                <mat-form-field class="spacer"><mat-label>Reply as participant (STOP, HELP, START, RESUME, EDIT 2, PROFILE, RESULTS …)</mat-label><input matInput [(ngModel)]="text" name="text" data-testid="sim-text" /></mat-form-field>
                <button mat-flat-button type="submit" [disabled]="!text.trim()" data-testid="sim-send"><mat-icon svgIcon="send" /> Send</button>
              </form>
            }
          </mat-card-content>
        </mat-card>
      </div>
      <mat-card>
        <mat-card-header><mat-card-title>Auth emulator outbox</mat-card-title><mat-card-subtitle>Password reset and verification links generated by the local Firebase Auth emulator</mat-card-subtitle></mat-card-header>
        <mat-card-content>
          <button mat-stroked-button type="button" (click)="loadOutbox()">Load outbox</button>
          @for (o of outbox(); track $index) { <div class="small">{{ o.email }} · {{ o.requestType }} · <a [href]="o.oobLink" target="_blank" rel="noopener">open link</a></div> }
          @if (outboxLoaded() && !outbox().length) { <p class="small muted">No messages in the emulator outbox.</p> }
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: [
    `
      .sim-layout { display: grid; grid-template-columns: 300px 1fr; gap: 16px; }
      @media (max-width: 900px) { .sim-layout { grid-template-columns: 1fr; } }
      .contact-list { max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
      .contact { text-align: left; border: 1px solid var(--mat-sys-outline-variant); background: transparent; padding: 8px; border-radius: 6px; cursor: pointer; font: inherit; }
      .contact.selected { background: var(--mat-sys-secondary-container); }
      .flow-form { margin-top: 8px; padding: 8px; border: 1px dashed #888; border-radius: 6px; display: flex; flex-direction: column; gap: 4px; }
      .linkish { border: none; background: none; color: var(--mat-sys-primary); cursor: pointer; padding: 0; font: inherit; font-size: 11px; text-decoration: underline; }
      .compact { width: 220px; }
    `,
  ],
})
export class SimulatorComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  readonly genders = GENDERS;
  readonly ageBands = AGE_BANDS;
  readonly memberships = MEMBERSHIP_KINDS;
  readonly state = signal<SimulatorStateDto | null>(null);
  readonly contacts = signal<ContactSummaryDto[]>([]);
  readonly selected = signal<ContactSummaryDto | null>(null);
  readonly selectedId = computed(() => this.selected()?.id ?? null);
  readonly messages = signal<SimMessage[]>([]);
  readonly outbox = signal<{ email: string; requestType: string; oobLink: string }[]>([]);
  readonly outboxLoaded = signal(false);
  readonly error = signal<string | null>(null);
  search = '';
  text = '';
  newPhone = '';
  newName = '';
  nextOutcome = '';
  expireWindow = false;
  failContact = false;
  timeoutContact = false;
  profile = { city: '', district: '', gender: '', ageBand: '', occupation: '', membership: '' };
  private readonly flowSelections = new Map<string, Set<string>>();

  constructor() {
    void this.refresh();
  }

  readonly refresh = async (): Promise<void> => {
    this.error.set(null);
    try {
      this.state.set(await this.api.get<SimulatorStateDto>('/dev/simulator/state'));
      await this.loadContacts();
      await this.loadConversation();
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    }
  };

  async loadContacts(): Promise<void> {
    const page = await this.api.get<Page<ContactSummaryDto>>('/dev/simulator/contacts', { search: this.search, limit: 100 });
    this.contacts.set(page.items);
    const current = this.selected();
    if (current && !page.items.some((contact) => contact.id === current.id)) this.selected.set(null);
  }

  async select(contact: ContactSummaryDto): Promise<void> {
    this.selected.set(contact);
    this.flowSelections.clear();
    await this.loadConversation();
  }

  async loadConversation(): Promise<void> {
    const contact = this.selected();
    if (!contact) {
      this.messages.set([]);
      return;
    }
    try {
      this.messages.set(await this.api.get<SimMessage[]>(`/dev/simulator/conversation/${contact.id}`));
    } catch (error) {
      this.notify.error(error);
    }
  }

  private async after(): Promise<void> {
    await this.drain();
  }

  async drain(): Promise<void> {
    try {
      const result = await this.api.post<{ processed: number }>('/dev/simulator/drain');
      this.state.set(await this.api.get<SimulatorStateDto>('/dev/simulator/state'));
      await this.loadConversation();
      if (result.processed === 0) this.notify.info('No queued jobs were due.');
    } catch (error) {
      this.notify.error(error);
    }
  }

  async clock(seconds: number): Promise<void> {
    try {
      this.state.set(await this.api.post<SimulatorStateDto>('/dev/simulator/clock', { advanceSeconds: seconds }));
      await this.drain();
    } catch (error) {
      this.notify.error(error);
    }
  }

  async resetClock(): Promise<void> {
    try {
      this.state.set(await this.api.post<SimulatorStateDto>('/dev/simulator/clock', { reset: true }));
    } catch (error) {
      this.notify.error(error);
    }
  }

  async faults(): Promise<void> {
    try {
      this.state.set(
        await this.api.post<SimulatorStateDto>('/dev/simulator/faults', {
          nextSendOutcome: this.nextOutcome || undefined,
          expireServiceWindowForContactId: this.expireWindow ? this.selectedId() : null,
          failForContactId: this.failContact ? this.selectedId() : null,
          timeoutForContactId: this.timeoutContact ? this.selectedId() : null,
        }),
      );
    } catch (error) {
      this.notify.error(error);
    }
  }

  async sendText(): Promise<void> {
    const contact = this.selected();
    if (!contact || !this.text.trim()) return;
    try {
      await this.api.post('/dev/simulator/text', { contactId: contact.id, text: this.text.trim() });
      this.text = '';
      await this.after();
    } catch (error) {
      this.notify.error(error);
    }
  }

  async sendUnknown(): Promise<void> {
    try {
      await this.api.post('/dev/simulator/text', { phone: this.newPhone.trim(), profileName: this.newName.trim() || undefined, text: 'HI' });
      await this.drain();
      await this.loadContacts();
      const match = this.contacts().find((contact) => contact.phoneE164.replace(/\D/g, '').endsWith(this.newPhone.replace(/\D/g, '').slice(-9)));
      if (match) await this.select(match);
    } catch (error) {
      this.notify.error(error);
    }
  }

  async tap(message: SimMessage, controlId: string): Promise<void> {
    const contact = this.selected();
    if (!contact) return;
    try {
      await this.api.post('/dev/simulator/tap', { contactId: contact.id, messageId: message.id, controlId });
      await this.after();
    } catch (error) {
      this.notify.error(error);
    }
  }

  isChecked(messageId: string, optionId: string): boolean {
    return this.flowSelections.get(messageId)?.has(optionId) ?? false;
  }

  toggle(message: SimMessage, optionId: string, checked: boolean): void {
    const set = this.flowSelections.get(message.id) ?? new Set<string>();
    if (message.flow?.purpose === 'SINGLE_CHOICE') set.clear();
    if (checked) set.add(optionId);
    else set.delete(optionId);
    this.flowSelections.set(message.id, set);
  }

  async submitFlow(message: SimMessage): Promise<void> {
    const contact = this.selected();
    if (!contact || !message.flow) return;
    const body: Record<string, unknown> = { contactId: contact.id, messageId: message.id, flowToken: message.flow.token };
    if (message.flow.purpose === 'PROFILE') {
      const profile: Record<string, string> = {};
      for (const [key, value] of Object.entries(this.profile)) if (value) profile[key] = value;
      body['profile'] = profile;
    } else body['selectedOptionIds'] = [...(this.flowSelections.get(message.id) ?? [])];
    try {
      await this.api.post('/dev/simulator/flow', body);
      await this.after();
    } catch (error) {
      this.notify.error(error);
    }
  }

  async status(message: SimMessage, status: 'DELIVERED' | 'READ' | 'FAILED', duplicate = false): Promise<void> {
    try {
      await this.api.post('/dev/simulator/status', { messageId: message.id, status, duplicate: duplicate || undefined, errorCode: status === 'FAILED' ? '131026' : undefined });
      await this.after();
    } catch (error) {
      this.notify.error(error);
    }
  }

  async loadOutbox(): Promise<void> {
    try {
      this.outbox.set(await this.api.get('/dev/simulator/outbox'));
      this.outboxLoaded.set(true);
    } catch (error) {
      this.notify.error(error);
    }
  }
}
