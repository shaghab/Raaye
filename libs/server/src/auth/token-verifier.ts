import { Inject, Injectable } from '@nestjs/common';
import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { DomainError } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/env';

export interface VerifiedIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
}

export interface TokenVerifier {
  verify(idToken: string): Promise<VerifiedIdentity>;
}

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** Firebase Admin wrapper. Honors FIREBASE_AUTH_EMULATOR_HOST only in emulator mode. */
@Injectable()
export class FirebaseAdminService {
  private readonly app: App;
  readonly auth: Auth;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    if (config.AUTH_MODE === 'live') {
      delete process.env['FIREBASE_AUTH_EMULATOR_HOST'];
    } else if (config.AUTH_MODE === 'emulator' && config.FIREBASE_AUTH_EMULATOR_HOST) {
      process.env['FIREBASE_AUTH_EMULATOR_HOST'] = config.FIREBASE_AUTH_EMULATOR_HOST;
    }
    const existing = getApps().find((app) => app.name === 'raaye');
    this.app = existing ?? initializeApp({ projectId: config.FIREBASE_PROJECT_ID }, 'raaye');
    this.auth = getAuth(this.app);
  }

  get projectId(): string {
    return this.config.FIREBASE_PROJECT_ID;
  }

  async createUser(email: string, password: string, displayName?: string): Promise<string> {
    const record = await this.auth.createUser({ email, password, displayName, emailVerified: true });
    return record.uid;
  }

  /** Removes an account that was provisioned for an acceptance that could not complete. */
  async deleteUser(uid: string): Promise<void> {
    await this.auth.deleteUser(uid);
  }

  async findUidByEmail(email: string): Promise<string | null> {
    try {
      const record = await this.auth.getUserByEmail(email);
      return record.uid;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async ensureUser(email: string, password: string, displayName?: string): Promise<string> {
    const existing = await this.findUidByEmail(email);
    if (existing) {
      await this.auth.updateUser(existing, { password, displayName, emailVerified: true });
      return existing;
    }
    return this.createUser(email, password, displayName);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'auth/user-not-found';
}

@Injectable()
export class FirebaseTokenVerifier implements TokenVerifier {
  constructor(private readonly firebase: FirebaseAdminService) {}

  async verify(idToken: string): Promise<VerifiedIdentity> {
    try {
      const decoded = await this.firebase.auth.verifyIdToken(idToken);
      if (!decoded.email) throw new DomainError('UNAUTHENTICATED', 'The account has no email address');
      return { uid: decoded.uid, email: decoded.email.toLowerCase(), emailVerified: Boolean(decoded.email_verified) };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('UNAUTHENTICATED', 'The sign-in token is invalid or expired');
    }
  }
}

/**
 * Deterministic verifier for integration tests only (AUTH_MODE=test, which the
 * configuration rejects outside APP_ENV=test). Tokens look like `test:<uid>:<email>`.
 */
@Injectable()
export class TestTokenVerifier implements TokenVerifier {
  async verify(idToken: string): Promise<VerifiedIdentity> {
    const [prefix, uid, email] = idToken.split(':');
    if (prefix !== 'test' || !uid || !email) throw new DomainError('UNAUTHENTICATED', 'Invalid test token');
    return { uid, email: email.toLowerCase(), emailVerified: true };
  }
}
