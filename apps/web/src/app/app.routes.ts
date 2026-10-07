import { Route } from '@angular/router';
import { anonymousGuard, authGuard, roleGuard, simulatorGuard } from './core/guards';

export const appRoutes: Route[] = [
  { path: 'login', canActivate: [anonymousGuard], loadComponent: () => import('./features/auth/login.component').then((m) => m.LoginComponent) },
  { path: 'reset-password', loadComponent: () => import('./features/auth/reset-password.component').then((m) => m.ResetPasswordComponent) },
  { path: 'accept-invitation', loadComponent: () => import('./features/auth/accept-invitation.component').then((m) => m.AcceptInvitationComponent) },
  { path: 'no-access', loadComponent: () => import('./features/auth/no-access.component').then((m) => m.NoAccessComponent) },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/shell.component').then((m) => m.ShellComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      { path: 'overview', loadComponent: () => import('./features/overview/overview.component').then((m) => m.OverviewComponent) },
      { path: 'contacts', canActivate: [roleGuard(['ADMIN', 'SURVEY_MANAGER'])], loadComponent: () => import('./features/contacts/contacts-list.component').then((m) => m.ContactsListComponent) },
      { path: 'contacts/new', canActivate: [roleGuard(['ADMIN', 'SURVEY_MANAGER'])], loadComponent: () => import('./features/contacts/contact-form.component').then((m) => m.ContactFormComponent) },
      { path: 'contacts/import', canActivate: [roleGuard(['ADMIN', 'SURVEY_MANAGER'])], loadComponent: () => import('./features/contacts/import-wizard.component').then((m) => m.ImportWizardComponent) },
      { path: 'contacts/groups', canActivate: [roleGuard(['ADMIN', 'SURVEY_MANAGER'])], loadComponent: () => import('./features/contacts/groups-tags.component').then((m) => m.GroupsTagsComponent) },
      { path: 'contacts/:id', canActivate: [roleGuard(['ADMIN', 'SURVEY_MANAGER'])], loadComponent: () => import('./features/contacts/contact-detail.component').then((m) => m.ContactDetailComponent) },
      { path: 'contacts/:id/edit', canActivate: [roleGuard(['ADMIN', 'SURVEY_MANAGER'])], loadComponent: () => import('./features/contacts/contact-form.component').then((m) => m.ContactFormComponent) },
      { path: 'surveys', loadComponent: () => import('./features/surveys/surveys-list.component').then((m) => m.SurveysListComponent) },
      { path: 'surveys/new', canActivate: [roleGuard(['ADMIN', 'SURVEY_MANAGER'])], loadComponent: () => import('./features/surveys/survey-editor.component').then((m) => m.SurveyEditorComponent) },
      { path: 'surveys/:id', loadComponent: () => import('./features/surveys/survey-detail.component').then((m) => m.SurveyDetailComponent) },
      { path: 'surveys/:id/edit', canActivate: [roleGuard(['ADMIN', 'SURVEY_MANAGER'])], loadComponent: () => import('./features/surveys/survey-editor.component').then((m) => m.SurveyEditorComponent) },
      { path: 'settings', loadComponent: () => import('./features/settings/settings.component').then((m) => m.SettingsComponent) },
      { path: 'audit', canActivate: [roleGuard(['ADMIN'])], loadComponent: () => import('./features/audit/audit.component').then((m) => m.AuditComponent) },
      { path: 'simulator', canActivate: [roleGuard(['ADMIN']), simulatorGuard], loadComponent: () => import('./features/simulator/simulator.component').then((m) => m.SimulatorComponent) },
    ],
  },
  { path: '**', redirectTo: '' },
];
