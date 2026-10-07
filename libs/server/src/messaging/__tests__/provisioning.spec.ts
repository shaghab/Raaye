import { provisionedConnection } from '../readiness.service';

describe('sender provisioning from Settings (R22, R57)', () => {
  it('creates a Meta live connection with an unguessable app key and a mock connection with the seed key', () => {
    expect(provisionedConnection('LIVE', 'pilap', 'a1b2c3d4e5f6a7b8')).toEqual({ provider: 'META', mode: 'LIVE', appKey: 'live-pilap-a1b2c3d4e5f6a7b8' });
    expect(provisionedConnection('MOCK', 'pilap', 'ignored')).toEqual({ provider: 'MOCK', mode: 'MOCK', appKey: 'mock-pilap' });
  });
});
