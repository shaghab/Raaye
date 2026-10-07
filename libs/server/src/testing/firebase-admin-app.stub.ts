/** Jest stub: firebase-admin pulls ESM-only dependencies that Jest cannot require. Tests use AUTH_MODE=test. */
export interface App {
  name: string;
}
const apps: App[] = [];
export function getApps(): App[] {
  return apps;
}
export function initializeApp(_options: unknown, name = '[DEFAULT]'): App {
  const app = { name };
  apps.push(app);
  return app;
}
