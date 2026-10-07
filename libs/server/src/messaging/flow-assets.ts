import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FlowPurpose } from '@raaye/contracts';

export interface FlowAsset {
  purpose: FlowPurpose;
  version: string;
  file: string;
  screen: string;
  json: Record<string, unknown>;
}

const FILES: Record<FlowPurpose, { file: string; screen: string; version: string }> = {
  SINGLE_CHOICE: { file: 'single-choice.v1.json', screen: 'QUESTION', version: 'single-choice.v1' },
  MULTI_CHOICE: { file: 'multi-choice.v1.json', screen: 'QUESTION', version: 'multi-choice.v1' },
  PROFILE: { file: 'profile.v1.json', screen: 'PROFILE', version: 'profile.v1' },
};

function flowsDirectory(): string {
  const candidates = [
    process.env['RAAYE_FLOWS_DIR'],
    path.resolve(process.cwd(), 'whatsapp/flows'),
    path.resolve(__dirname, '../../../../whatsapp/flows'),
    path.resolve(__dirname, '../../../../../whatsapp/flows'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      readFileSync(path.join(candidate, FILES.MULTI_CHOICE.file));
      return candidate;
    } catch {
      // try next
    }
  }
  return path.resolve(process.cwd(), 'whatsapp/flows');
}

const cache = new Map<FlowPurpose, FlowAsset>();

/** Checked-in, versioned Flow JSON definitions. */
export function loadFlowAsset(purpose: FlowPurpose): FlowAsset {
  const cached = cache.get(purpose);
  if (cached) return cached;
  const spec = FILES[purpose];
  const json = JSON.parse(readFileSync(path.join(flowsDirectory(), spec.file), 'utf8')) as Record<string, unknown>;
  const asset = { purpose, version: spec.version, file: spec.file, screen: spec.screen, json };
  cache.set(purpose, asset);
  return asset;
}

export function flowAssetVersion(purpose: FlowPurpose): string {
  return FILES[purpose].version;
}
