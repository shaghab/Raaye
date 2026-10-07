import { z } from 'zod';
import { ROLES, type Role } from './enums';

export interface MeDto {
  userId: string;
  email: string;
  displayName: string | null;
  organization: { id: string; name: string; slug: string; timezone: string };
  role: Role;
  membershipId: string;
  features: {
    messagingMode: 'mock' | 'live';
    simulatorEnabled: boolean;
    appEnv: string;
  };
}

export interface MemberDto {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
  status: 'ACTIVE' | 'REVOKED';
  createdAt: string;
}

export const memberUpdateSchema = z.object({
  role: z.enum(ROLES),
});
export type MemberUpdate = z.infer<typeof memberUpdateSchema>;

export const staffInvitationCreateSchema = z.object({
  email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
  role: z.enum(ROLES),
});
export type StaffInvitationCreate = z.infer<typeof staffInvitationCreateSchema>;

export interface StaffInvitationDto {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** Only present in the create response; never stored or listed again. */
  acceptUrl?: string;
}

export const staffInvitationAcceptSchema = z.object({
  token: z.string().trim().min(20).max(200),
  /** Required for a brand new account; omitted when an existing signed-in user accepts. */
  password: z.string().min(8).max(128).optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
});
export type StaffInvitationAccept = z.infer<typeof staffInvitationAcceptSchema>;

export const staffInvitationInspectSchema = z.object({
  token: z.string().trim().min(20).max(200),
});

export interface StaffInvitationInspectDto {
  email: string;
  role: Role;
  organizationName: string;
  expiresAt: string;
  existingAccount: boolean;
}

/** Public bootstrap settings for the browser; never contains secrets. */
export interface AuthConfigDto {
  authMode: 'emulator' | 'live' | 'test';
  projectId: string;
  apiKey: string;
  /** Present only when the Firebase Auth emulator is in use. */
  emulatorUrl: string | null;
  messagingMode: 'mock' | 'live';
  simulatorEnabled: boolean;
  appEnv: string;
}
