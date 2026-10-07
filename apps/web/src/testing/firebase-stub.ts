/** Jest stand-in for the Firebase client SDK: dashboard unit tests never talk to Firebase. */
export const initializeApp = (): object => ({});
export const getAuth = (): { currentUser: null } => ({ currentUser: null });
export const connectAuthEmulator = (): void => undefined;
export const setPersistence = async (): Promise<void> => undefined;
export const browserLocalPersistence = {};
export const onAuthStateChanged = (_auth: unknown, next: (user: null) => void): (() => void) => {
  next(null);
  return () => undefined;
};
export const signInWithEmailAndPassword = async (): Promise<never> => {
  throw new Error('not available in unit tests');
};
export const signOut = async (): Promise<void> => undefined;
export const sendPasswordResetEmail = async (): Promise<void> => undefined;
