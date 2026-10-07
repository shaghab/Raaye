/** Jest stub for firebase-admin/auth. Never used by integration tests (AUTH_MODE=test). */
export interface Auth {
  verifyIdToken(token: string): Promise<{ uid: string; email?: string; email_verified?: boolean }>;
  createUser(input: { email: string; password?: string; displayName?: string; emailVerified?: boolean }): Promise<{ uid: string }>;
  getUserByEmail(email: string): Promise<{ uid: string }>;
  updateUser(uid: string, input: unknown): Promise<{ uid: string }>;
}
const users = new Map<string, { uid: string; email: string }>();
export function getAuth(): Auth {
  return {
    async verifyIdToken() {
      throw Object.assign(new Error('stubbed firebase auth'), { code: 'auth/argument-error' });
    },
    async createUser(input) {
      const uid = `stub-${users.size + 1}`;
      users.set(input.email.toLowerCase(), { uid, email: input.email.toLowerCase() });
      return { uid };
    },
    async getUserByEmail(email) {
      const found = users.get(email.toLowerCase());
      if (!found) throw Object.assign(new Error('not found'), { code: 'auth/user-not-found' });
      return { uid: found.uid };
    },
    async updateUser(uid) {
      return { uid };
    },
  };
}
