import { Injectable, computed, signal } from '@angular/core';
import type { AuthConfigDto, MeDto, Role } from '@raaye/contracts';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import { ApiError } from './api.service';

/**
 * Firebase Authentication client (emulator locally, live project in production) plus the
 * staff membership loaded from the API. The API, not the client, decides the role.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly config = signal<AuthConfigDto | null>(null);
  readonly user = signal<User | null>(null);
  readonly ready = signal(false);
  readonly me = signal<MeDto | null>(null);
  readonly membershipError = signal<ApiError | null>(null);
  readonly role = computed<Role | null>(() => this.me()?.role ?? null);
  readonly messagingMode = computed(() => this.me()?.features.messagingMode ?? this.config()?.messagingMode ?? 'mock');
  readonly simulatorEnabled = computed(() => this.me()?.features.simulatorEnabled ?? this.config()?.simulatorEnabled ?? false);
  readonly timezone = computed(() => this.me()?.organization.timezone ?? 'Asia/Karachi');
  private app: FirebaseApp | null = null;
  private auth: Auth | null = null;

  async init(): Promise<void> {
    try {
      const response = await fetch('/api/v1/auth/config', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`auth config ${response.status}`);
      const config = (await response.json()) as AuthConfigDto;
      this.config.set(config);
      this.app = initializeApp({ apiKey: config.apiKey || 'missing-api-key', projectId: config.projectId, authDomain: `${config.projectId}.firebaseapp.com` }, 'raaye');
      this.auth = getAuth(this.app);
      if (config.emulatorUrl) connectAuthEmulator(this.auth, config.emulatorUrl, { disableWarnings: true });
      await setPersistence(this.auth, browserLocalPersistence);
      await new Promise<void>((resolve) => {
        const unsubscribe = onAuthStateChanged(this.auth as Auth, (user) => {
          this.user.set(user);
          unsubscribe();
          resolve();
        });
      });
      onAuthStateChanged(this.auth, (user) => {
        this.user.set(user);
        if (!user) {
          this.me.set(null);
          this.membershipError.set(null);
        }
      });
      if (this.user()) await this.loadMe();
    } catch (error) {
      this.membershipError.set(ApiError.from(error));
    } finally {
      this.ready.set(true);
    }
  }

  hasRole(...roles: Role[]): boolean {
    const role = this.role();
    return role !== null && roles.includes(role);
  }

  async idToken(forceRefresh = false): Promise<string | null> {
    const user = this.auth?.currentUser ?? null;
    if (!user) return null;
    return user.getIdToken(forceRefresh);
  }

  async signIn(email: string, password: string): Promise<void> {
    if (!this.auth) throw new Error('Authentication is not initialized');
    const credential = await signInWithEmailAndPassword(this.auth, email, password);
    this.user.set(credential.user);
    await this.loadMe();
  }

  async signOut(): Promise<void> {
    if (this.auth) await signOut(this.auth);
    this.user.set(null);
    this.me.set(null);
    this.membershipError.set(null);
  }

  async resetPassword(email: string): Promise<void> {
    if (!this.auth) throw new Error('Authentication is not initialized');
    await sendPasswordResetEmail(this.auth, email);
  }

  /** Loads the active membership; a signed-in user without one is not a staff member. */
  async loadMe(): Promise<MeDto | null> {
    try {
      const token = await this.idToken();
      if (!token) return null;
      const response = await fetch('/api/v1/me', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      const body: unknown = await response.json();
      if (!response.ok) {
        const error = body as { code?: string; message?: string; correlationId?: string };
        throw new ApiError(response.status, (error.code as ApiError['code']) ?? 'INTERNAL_ERROR', error.message ?? 'Request failed', error.correlationId ?? null);
      }
      const me = body as MeDto;
      this.me.set(me);
      this.membershipError.set(null);
      return me;
    } catch (error) {
      this.me.set(null);
      this.membershipError.set(ApiError.from(error));
      return null;
    }
  }
}
