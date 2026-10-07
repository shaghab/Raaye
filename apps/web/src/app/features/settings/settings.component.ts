import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTableModule } from '@angular/material/table';
import { MatTabsModule } from '@angular/material/tabs';
import { FLOW_PURPOSES, ROLES, TEMPLATE_PURPOSES, type MemberDto, type MessagingConfiguration, type MessagingReadinessDto, type OrganizationDto, type OrganizationUpdate, type StaffInvitationDto } from '@raaye/contracts';
import { ApiError, ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { NotifyService } from '../../core/notify.service';
import { ConfirmService, SHARED } from '../../shared/ui';

@Component({
  selector: 'rye-settings',
  imports: [...SHARED, FormsModule, MatCardModule, MatTabsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule, MatSlideToggleModule, MatTableModule],
  template: `
    <div class="page">
      <div class="page-header"><h1>Settings</h1></div>
      <rye-state [loading]="loading()" [error]="error()" [retry]="load" />
      @if (org(); as o) {
        <mat-tab-group animationDuration="0ms">
          <mat-tab label="Organization">
            <div class="tab-body">
              <mat-card>
                <mat-card-content>
                  <form class="form-grid" (ngSubmit)="saveOrg()">
                    <mat-form-field><mat-label>Name</mat-label><input matInput name="name" [(ngModel)]="orgForm.name" [disabled]="!isAdmin" required maxlength="150" /></mat-form-field>
                    <mat-form-field><mat-label>Timezone (IANA)</mat-label><input matInput name="timezone" [(ngModel)]="orgForm.timezone" [disabled]="!isAdmin" required /></mat-form-field>
                    <mat-form-field><mat-label>Privacy notice URL</mat-label><input matInput name="privacyUrl" [(ngModel)]="orgForm.privacyUrl" [disabled]="!isAdmin" /></mat-form-field>
                    <mat-form-field><mat-label>Support contact shown to participants</mat-label><input matInput name="supportContact" [(ngModel)]="orgForm.supportContact" [disabled]="!isAdmin" /></mat-form-field>
                    <mat-form-field class="full"><mat-label>Participant notice (sent with every invitation)</mat-label><textarea matInput name="participantNotice" [(ngModel)]="orgForm.participantNotice" [disabled]="!isAdmin" rows="3" maxlength="1500"></textarea><mat-hint>Version {{ o.participantNoticeVersion }}. Must state that answers are identifiable to authorized administrators.</mat-hint></mat-form-field>
                    <div class="full"><mat-slide-toggle name="profileOnboardingEnabled" [(ngModel)]="orgForm.profileOnboardingEnabled" [disabled]="!isAdmin">Offer optional profile questions after Start survey</mat-slide-toggle></div>
                    @if (isAdmin) { <div class="full row"><button mat-flat-button type="submit" [disabled]="saving()">Save organization</button></div> } @else { <p class="full small muted">Only Admins change organization settings.</p> }
                  </form>
                </mat-card-content>
              </mat-card>
              <p class="small muted">Slug: {{ o.slug }} · default locale {{ o.defaultLocale }} @if (o.isDemo) { · demo organization }</p>
            </div>
          </mat-tab>
          @if (isAdmin) {
            <mat-tab label="Survey defaults">
              <div class="tab-body">
                <mat-card>
                  <mat-card-content>
                    <form class="form-grid" (ngSubmit)="saveDefaults()">
                      <mat-form-field><mat-label>Default duration (hours)</mat-label><input matInput type="number" name="durationHours" [(ngModel)]="defaultsForm.durationHours" min="1" max="720" /><mat-hint>Measured from the opening time. 1 hour to 30 days.</mat-hint></mat-form-field>
                      <mat-form-field><mat-label>Default answer edit window (seconds)</mat-label><input matInput type="number" name="editWindow" [(ngModel)]="defaultsForm.editWindowSeconds" min="0" max="3600" /><mat-hint>Starts at the first accepted answer and never resets. 0 disables edits.</mat-hint></mat-form-field>
                      <div class="full row"><button mat-flat-button type="submit" [disabled]="saving()">Save defaults</button></div>
                    </form>
                    <p class="small muted">Survey Managers use these defaults; only Admins override them per survey.</p>
                  </mat-card-content>
                </mat-card>
              </div>
            </mat-tab>
            <mat-tab label="Staff">
              <div class="tab-body">
                <mat-card>
                  <mat-card-header><mat-card-title>Members</mat-card-title></mat-card-header>
                  <mat-card-content>
                    <div class="table-wrap">
                      <table mat-table [dataSource]="members()">
                        <ng-container matColumnDef="email"><th mat-header-cell *matHeaderCellDef>Email</th><td mat-cell *matCellDef="let m">{{ m.email }} <span class="small muted">{{ m.displayName }}</span></td></ng-container>
                        <ng-container matColumnDef="role"><th mat-header-cell *matHeaderCellDef>Role</th><td mat-cell *matCellDef="let m">
                          <mat-form-field class="compact"><mat-select [value]="m.role" (selectionChange)="changeRole(m, $event.value)" [disabled]="m.userId === auth.me()?.userId" aria-label="Role">@for (r of roles; track r) { <mat-option [value]="r">{{ r | label }}</mat-option> }</mat-select></mat-form-field>
                        </td></ng-container>
                        <ng-container matColumnDef="since"><th mat-header-cell *matHeaderCellDef>Member since</th><td mat-cell *matCellDef="let m">{{ m.createdAt | dt: 'date' }}</td></ng-container>
                        <ng-container matColumnDef="actions"><th mat-header-cell *matHeaderCellDef></th><td mat-cell *matCellDef="let m">@if (m.userId !== auth.me()?.userId) { <button mat-button type="button" class="danger" (click)="revoke(m)">Revoke</button> }</td></ng-container>
                        <tr mat-header-row *matHeaderRowDef="memberColumns"></tr>
                        <tr mat-row *matRowDef="let row; columns: memberColumns"></tr>
                      </table>
                    </div>
                    <p class="small muted">The last Admin cannot be demoted or revoked. Revocation takes effect on the next request.</p>
                  </mat-card-content>
                </mat-card>
                <mat-card>
                  <mat-card-header><mat-card-title>Invitations</mat-card-title></mat-card-header>
                  <mat-card-content>
                    <form class="row" (ngSubmit)="invite()">
                      <mat-form-field><mat-label>Email</mat-label><input matInput type="email" name="inviteEmail" [(ngModel)]="inviteEmail" required /></mat-form-field>
                      <mat-form-field><mat-label>Role</mat-label><mat-select name="inviteRole" [(ngModel)]="inviteRole">@for (r of roles; track r) { <mat-option [value]="r">{{ r | label }}</mat-option> }</mat-select></mat-form-field>
                      <button mat-flat-button type="submit" [disabled]="!inviteEmail">Create invitation</button>
                    </form>
                    @if (lastInviteUrl(); as url) {
                      <div class="banner ok">Invitation created. Share this single-use link (valid 72 hours); it is shown only once:<br /><code class="mono">{{ url }}</code></div>
                    }
                    @for (i of invitations(); track i.id) {
                      <div class="row small">
                        <span>{{ i.email }} · {{ i.role | label }} · expires {{ i.expiresAt | dt }}</span>
                        @if (i.acceptedAt) { <rye-chip text="Accepted" tone="ok" /> } @else if (i.revokedAt) { <rye-chip text="Revoked" tone="neutral" /> } @else { <rye-chip text="Pending" tone="info" /> <button mat-button type="button" (click)="revokeInvitation(i)">Revoke</button> }
                      </div>
                    }
                  </mat-card-content>
                </mat-card>
              </div>
            </mat-tab>
            <mat-tab label="Messaging">
              <div class="tab-body">
                <rye-state [loading]="messagingLoading()" />
                @if (readiness(); as r) {
                  <div class="banner" [class.ok]="r.ok" [class.warn]="!r.ok">
                    <strong>{{ r.mode === 'live' ? 'LIVE WhatsApp Cloud API' : 'MOCK provider' }}</strong> · {{ r.ok ? 'ready' : 'not ready' }} · checked {{ r.checkedAt | dt }}
                    @if (r.blockers.length) { <ul>@for (b of r.blockers; track b.code) { <li>{{ b.message }}</li> }</ul> }
                    @if (r.warnings.length) { <ul class="small">@for (w of r.warnings; track w.code) { <li>{{ w.message }}</li> }</ul> }
                  </div>
                  <mat-card>
                    <mat-card-header><mat-card-title>Sender configuration</mat-card-title><mat-card-subtitle>Secrets are referenced by environment variable name; values are never stored or shown here.</mat-card-subtitle></mat-card-header>
                    <mat-card-content>
                      <form class="form-grid" (ngSubmit)="saveMessaging()">
                        <mat-form-field><mat-label>Phone number ID</mat-label><input matInput name="phoneNumberId" [(ngModel)]="msg.phoneNumberId" /></mat-form-field>
                        <mat-form-field><mat-label>WABA ID</mat-label><input matInput name="wabaId" [(ngModel)]="msg.wabaId" /></mat-form-field>
                        <mat-form-field><mat-label>App ID</mat-label><input matInput name="appId" [(ngModel)]="msg.appId" /></mat-form-field>
                        <mat-form-field><mat-label>Display phone number</mat-label><input matInput name="displayPhoneNumber" [(ngModel)]="msg.displayPhoneNumber" /></mat-form-field>
                        <mat-form-field><mat-label>Graph API version</mat-label><input matInput name="graphVersion" [(ngModel)]="msg.graphVersion" placeholder="v24.0" /></mat-form-field>
                        <mat-form-field><mat-label>App secret reference (env var)</mat-label><input matInput name="appSecretRef" [(ngModel)]="msg.appSecretRef" placeholder="META_APP_SECRET" /></mat-form-field>
                        <mat-form-field><mat-label>Access token reference (env var)</mat-label><input matInput name="accessTokenRef" [(ngModel)]="msg.accessTokenRef" placeholder="META_ACCESS_TOKEN" /></mat-form-field>
                        <mat-form-field><mat-label>Webhook verify token reference (env var)</mat-label><input matInput name="verifyTokenRef" [(ngModel)]="msg.verifyTokenRef" placeholder="META_WEBHOOK_VERIFY_TOKEN" /></mat-form-field>
                        <div class="full"><mat-slide-toggle name="enabled" [(ngModel)]="msg.enabled">Connection enabled</mat-slide-toggle></div>
                        <div class="full"><strong>Template bindings</strong> <span class="small muted">(approved names from WhatsApp Manager; see whatsapp/templates)</span></div>
                        @for (t of msg.templates; track t.purpose) {
                          <mat-form-field><mat-label>{{ t.purpose | label }} template name</mat-label><input matInput [name]="'tpl' + t.purpose" [(ngModel)]="t.providerName" /></mat-form-field>
                          <mat-form-field><mat-label>Language</mat-label><input matInput [name]="'tplLang' + t.purpose" [(ngModel)]="t.locale" /></mat-form-field>
                          <mat-form-field><mat-label>Quick-reply button index</mat-label><input matInput type="number" [name]="'tplBtn' + t.purpose" [(ngModel)]="t.buttonPosition" min="0" max="9" /></mat-form-field>
                        }
                        <div class="full"><strong>Flow bindings</strong> <span class="small muted">(published Flow IDs for the checked-in assets)</span></div>
                        @for (f of msg.flows; track f.purpose) {
                          <mat-form-field><mat-label>{{ f.purpose | label }} Flow ID</mat-label><input matInput [name]="'flow' + f.purpose" [(ngModel)]="f.providerFlowId" /></mat-form-field>
                        }
                        <div class="full row">
                          <button mat-flat-button type="submit" [disabled]="saving()">Save configuration</button>
                          <button mat-stroked-button type="button" [disabled]="saving() || r.mode !== 'live'" (click)="refreshStatus()"><mat-icon svgIcon="refresh" /> Refresh template/Flow status from Meta</button>
                        </div>
                      </form>
                    </mat-card-content>
                  </mat-card>
                  <mat-card>
                    <mat-card-header><mat-card-title>Status</mat-card-title></mat-card-header>
                    <mat-card-content>
                      <p class="small">Webhook path: <code class="mono">{{ r.webhookPath || '—' }}</code> · connection {{ r.connection?.enabled ? 'enabled' : 'disabled' }} · provider {{ r.provider | label }}</p>
                      @for (t of r.templates; track t.purpose + t.locale) { <div class="small">{{ t.purpose | label }}: {{ t.providerName }} ({{ t.locale }}) <rye-chip [code]="t.status" /> {{ t.category || '' }} · checked {{ t.lastCheckedAt | dt }}</div> }
                      @for (f of r.flows; track f.purpose + f.locale) { <div class="small">{{ f.purpose | label }} Flow: {{ f.providerFlowId || 'not bound' }} <rye-chip [code]="f.status" /> asset {{ f.assetVersion }} · checked {{ f.lastCheckedAt | dt }}</div> }
                      <p class="small muted">Approval states come from Meta. The app never assumes a template or Flow is approved.</p>
                    </mat-card-content>
                  </mat-card>
                  <mat-card>
                    <mat-card-header><mat-card-title>Policy review</mat-card-title></mat-card-header>
                    <mat-card-content>
                      <p class="small">An attestation that staff reviewed the WhatsApp Business Messaging Policy for this organization's purpose. It records a review, not Meta certification.</p>
                      <p class="small">Last reviewed: {{ o.livePolicyReviewedAt | dt }}</p>
                      <button mat-stroked-button type="button" (click)="attestPolicy()">Record policy review now</button>
                    </mat-card-content>
                  </mat-card>
                }
              </div>
            </mat-tab>
          }
        </mat-tab-group>
      }
    </div>
  `,
  styles: ['.tab-body { padding-top: 16px; } .compact { width: 180px; }'],
})
export class SettingsComponent {
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly confirm = inject(ConfirmService);
  readonly roles = ROLES;
  readonly memberColumns = ['email', 'role', 'since', 'actions'];
  readonly isAdmin = this.auth.hasRole('ADMIN');
  readonly org = signal<OrganizationDto | null>(null);
  readonly members = signal<MemberDto[]>([]);
  readonly invitations = signal<StaffInvitationDto[]>([]);
  readonly readiness = signal<MessagingReadinessDto | null>(null);
  readonly lastInviteUrl = signal<string | null>(null);
  readonly loading = signal(false);
  readonly messagingLoading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  orgForm = { name: '', timezone: '', privacyUrl: '', supportContact: '', participantNotice: '', profileOnboardingEnabled: true };
  defaultsForm = { durationHours: 48, editWindowSeconds: 120 };
  inviteEmail = '';
  inviteRole: (typeof ROLES)[number] = 'VIEWER';
  msg: { phoneNumberId: string; wabaId: string; appId: string; displayPhoneNumber: string; graphVersion: string; appSecretRef: string; accessTokenRef: string; verifyTokenRef: string; enabled: boolean; templates: { purpose: (typeof TEMPLATE_PURPOSES)[number]; providerName: string; locale: string; buttonPosition: number }[]; flows: { purpose: (typeof FLOW_PURPOSES)[number]; locale: string; providerFlowId: string }[] } = {
    phoneNumberId: '',
    wabaId: '',
    appId: '',
    displayPhoneNumber: '',
    graphVersion: '',
    appSecretRef: '',
    accessTokenRef: '',
    verifyTokenRef: '',
    enabled: true,
    templates: TEMPLATE_PURPOSES.map((purpose) => ({ purpose, providerName: '', locale: 'en', buttonPosition: 0 })),
    flows: FLOW_PURPOSES.map((purpose) => ({ purpose, locale: 'en', providerFlowId: '' })),
  };

  constructor() {
    void this.load();
  }

  readonly load = async (): Promise<void> => {
    this.loading.set(true);
    this.error.set(null);
    try {
      const org = await this.api.get<OrganizationDto>('/organization');
      this.org.set(org);
      this.orgForm = { name: org.name, timezone: org.timezone, privacyUrl: org.privacyUrl ?? '', supportContact: org.supportContact ?? '', participantNotice: org.participantNotice, profileOnboardingEnabled: org.profileOnboardingEnabled };
      this.defaultsForm = { durationHours: Math.round(org.defaultDurationSeconds / 3600), editWindowSeconds: org.defaultEditWindowSeconds };
      if (this.isAdmin) {
        const [members, invitations] = await Promise.all([this.api.get<MemberDto[]>('/members'), this.api.get<StaffInvitationDto[]>('/staff-invitations')]);
        this.members.set(members);
        this.invitations.set(invitations);
        await this.loadMessaging();
      }
    } catch (error) {
      this.error.set(ApiError.from(error).message);
    } finally {
      this.loading.set(false);
    }
  };

  private async loadMessaging(): Promise<void> {
    this.messagingLoading.set(true);
    try {
      const readiness = await this.api.get<MessagingReadinessDto>('/messaging/readiness');
      this.readiness.set(readiness);
      const connection = readiness.connection;
      this.msg = {
        phoneNumberId: connection?.phoneNumberId ?? '',
        wabaId: connection?.wabaId ?? '',
        appId: connection?.appId ?? '',
        displayPhoneNumber: connection?.displayPhoneNumber ?? '',
        graphVersion: connection?.graphVersion ?? '',
        appSecretRef: connection?.appSecretRef ?? '',
        accessTokenRef: connection?.accessTokenRef ?? '',
        verifyTokenRef: connection?.verifyTokenRef ?? '',
        enabled: connection?.enabled ?? true,
        templates: TEMPLATE_PURPOSES.map((purpose) => {
          const bound = readiness.templates.find((template) => template.purpose === purpose);
          return { purpose, providerName: bound?.providerName ?? '', locale: bound?.locale ?? 'en', buttonPosition: bound?.buttonPosition ?? 0 };
        }),
        flows: FLOW_PURPOSES.map((purpose) => {
          const bound = readiness.flows.find((flow) => flow.purpose === purpose);
          return { purpose, locale: bound?.locale ?? 'en', providerFlowId: bound?.providerFlowId ?? '' };
        }),
      };
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.messagingLoading.set(false);
    }
  }

  async saveOrg(): Promise<void> {
    const body: OrganizationUpdate = {
      name: this.orgForm.name.trim(),
      timezone: this.orgForm.timezone.trim(),
      privacyUrl: this.orgForm.privacyUrl.trim() || null,
      supportContact: this.orgForm.supportContact.trim() || null,
      participantNotice: this.orgForm.participantNotice.trim(),
      profileOnboardingEnabled: this.orgForm.profileOnboardingEnabled,
    };
    await this.patchOrg(body, 'Organization saved');
  }

  async saveDefaults(): Promise<void> {
    await this.patchOrg({ defaultDurationSeconds: Math.round(Number(this.defaultsForm.durationHours) * 3600), defaultEditWindowSeconds: Number(this.defaultsForm.editWindowSeconds) }, 'Defaults saved');
  }

  async attestPolicy(): Promise<void> {
    if (!(await this.confirm.ask({ title: 'Record policy review', message: 'Confirm that staff reviewed the WhatsApp Business Messaging Policy and the organization purpose for live messaging. This records a review date; it is not Meta approval.', confirmLabel: 'Record review' }))) return;
    await this.patchOrg({ livePolicyReviewed: true }, 'Policy review recorded');
    await this.loadMessaging();
  }

  private async patchOrg(body: OrganizationUpdate, message: string): Promise<void> {
    this.saving.set(true);
    try {
      const org = await this.api.patch<OrganizationDto>('/organization', body);
      this.org.set(org);
      this.notify.success(message);
      await this.auth.loadMe();
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.saving.set(false);
    }
  }

  async changeRole(member: MemberDto, role: MemberDto['role']): Promise<void> {
    try {
      await this.api.patch(`/members/${member.id}`, { role });
      this.notify.success(`${member.email} is now ${role}`);
      this.members.set(await this.api.get<MemberDto[]>('/members'));
    } catch (error) {
      this.notify.error(error);
      this.members.set(await this.api.get<MemberDto[]>('/members'));
    }
  }

  async revoke(member: MemberDto): Promise<void> {
    if (!(await this.confirm.ask({ title: 'Revoke membership', message: `${member.email} loses access immediately.`, confirmLabel: 'Revoke', destructive: true }))) return;
    try {
      await this.api.delete(`/members/${member.id}`);
      this.notify.success('Membership revoked');
      this.members.set(await this.api.get<MemberDto[]>('/members'));
    } catch (error) {
      this.notify.error(error);
    }
  }

  async invite(): Promise<void> {
    try {
      const invitation = await this.api.post<StaffInvitationDto>('/staff-invitations', { email: this.inviteEmail.trim(), role: this.inviteRole });
      this.lastInviteUrl.set(invitation.acceptUrl ?? null);
      this.inviteEmail = '';
      this.invitations.set(await this.api.get<StaffInvitationDto[]>('/staff-invitations'));
    } catch (error) {
      this.notify.error(error);
    }
  }

  async revokeInvitation(invitation: StaffInvitationDto): Promise<void> {
    try {
      await this.api.delete(`/staff-invitations/${invitation.id}`);
      this.invitations.set(await this.api.get<StaffInvitationDto[]>('/staff-invitations'));
    } catch (error) {
      this.notify.error(error);
    }
  }

  async saveMessaging(): Promise<void> {
    this.saving.set(true);
    const body: MessagingConfiguration = {
      phoneNumberId: this.msg.phoneNumberId.trim() || null,
      wabaId: this.msg.wabaId.trim() || null,
      appId: this.msg.appId.trim() || null,
      displayPhoneNumber: this.msg.displayPhoneNumber.trim() || null,
      graphVersion: this.msg.graphVersion.trim() || null,
      appSecretRef: this.msg.appSecretRef.trim() || null,
      accessTokenRef: this.msg.accessTokenRef.trim() || null,
      verifyTokenRef: this.msg.verifyTokenRef.trim() || null,
      enabled: this.msg.enabled,
      templates: this.msg.templates.filter((template) => template.providerName.trim()).map((template) => ({ purpose: template.purpose, providerName: template.providerName.trim(), locale: template.locale.trim() || 'en', buttonPosition: Number(template.buttonPosition) })),
      flows: this.msg.flows.map((flow) => ({ purpose: flow.purpose, locale: flow.locale.trim() || 'en', providerFlowId: flow.providerFlowId.trim() || null })),
    };
    try {
      this.readiness.set(await this.api.patch<MessagingReadinessDto>('/messaging/configuration', body));
      this.notify.success('Messaging configuration saved');
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.saving.set(false);
    }
  }

  async refreshStatus(): Promise<void> {
    this.saving.set(true);
    try {
      this.readiness.set(await this.api.post<MessagingReadinessDto>('/messaging/refresh-status'));
      this.notify.success('Status refreshed from Meta');
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.saving.set(false);
    }
  }
}
