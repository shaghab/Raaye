import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { LIMITS } from '@raaye/contracts';
import { generateToken, hashToken, type Clock } from '@raaye/domain';
import { z } from 'zod';
import { CLOCK } from '../clock/clock.service';
import { DomainError } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { Prisma } from '../persistence/generated/client';
import { PrismaService } from '../persistence/prisma.service';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const bootstrapInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens (2-64 characters)'),
  adminEmail: z.email().max(254).transform((value) => value.trim().toLowerCase()),
  supportContact: z.string().trim().min(1).max(200).optional(),
  timezone: z.string().trim().refine(isTimeZone, 'Unknown IANA time zone').optional(),
});
export type BootstrapInput = z.infer<typeof bootstrapInputSchema>;

export interface BootstrapResult {
  organizationId: string;
  slug: string;
  /** False when the slug already existed (without an active Admin) and was reused. */
  organizationCreated: boolean;
  invitationId: string;
  adminEmail: string;
  /** Single-use acceptance link; printed once and never stored in clear text. */
  acceptUrl: string;
  expiresAt: string;
  /** Earlier bootstrap invitations for the same address that this run revoked. */
  revokedInvitations: number;
}

export const BOOTSTRAP_USAGE =
  'Usage: bootstrap:org --name "<organization name>" --slug <slug> --admin-email <email> [--support-contact <text>] [--timezone <IANA zone>]';

/** Parse `--key value` / `--key=value` options into the shape the schema validates. Throws on unknown options. */
export function parseBootstrapArgs(args: string[]): Record<string, string | undefined> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      slug: { type: 'string' },
      'admin-email': { type: 'string' },
      'support-contact': { type: 'string' },
      timezone: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    name: values.name,
    slug: values.slug,
    adminEmail: values['admin-email'],
    supportContact: values['support-contact'],
    timezone: values.timezone,
  };
}

/** Wording the first Admin reviews in Settings → Organization before any survey is launched. */
export function defaultParticipantNotice(organizationName: string): string {
  return `${organizationName} runs voluntary surveys over WhatsApp. Your answers are linked to your contact record and visible only to authorized administrators. Reply STOP at any time to receive no further messages.`;
}

/**
 * Operator bootstrap for a live deployment (issue #13): creates the organization when its slug is
 * new and issues a single-use Admin invitation that the invitee accepts through the normal
 * invitation flow (token, email, Firebase identity, expiry and single use are all verified there).
 * It is independent of `ALLOW_DEMO_BOOTSTRAP`: no accounts, passwords or synthetic data are created.
 * An organization that already has an active Admin is refused; further staff are invited from Settings.
 */
@Injectable()
export class OrganizationBootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async bootstrap(raw: unknown, correlationId = `bootstrap-${randomUUID()}`): Promise<BootstrapResult> {
    const parsed = bootstrapInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Invalid bootstrap input',
        undefined,
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    }
    const input = parsed.data;
    const token = generateToken(32);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + LIMITS.staffInvitationHours * 3600 * 1000);
    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        let organization = await tx.organization.findUnique({ where: { slug: input.slug } });
        let organizationCreated = false;
        if (organization) {
          // The row lock serializes a re-run with invitation acceptance and with concurrent re-runs.
          await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organization.id}::uuid FOR UPDATE`;
          const activeAdmins = await tx.organizationMembership.count({
            where: { organizationId: organization.id, role: 'ADMIN', status: 'ACTIVE' },
          });
          if (activeAdmins > 0) {
            throw new DomainError(
              'BOOTSTRAP_REFUSED',
              `Organization "${input.slug}" already has an active Admin; invite further staff from Settings → Staff`,
              { activeAdmins },
            );
          }
        } else {
          organization = await tx.organization.create({
            data: {
              name: input.name,
              slug: input.slug,
              timezone: input.timezone ?? this.config.DEFAULT_TIMEZONE,
              participantNotice: defaultParticipantNotice(input.name),
              supportContact: input.supportContact ?? null,
              isDemo: false,
            },
          });
          organizationCreated = true;
        }
        // A re-run before acceptance replaces the earlier bootstrap link; Admin-issued invitations are untouched.
        const revoked = await tx.staffInvitation.updateMany({
          where: { organizationId: organization.id, email: input.adminEmail, invitedByUserId: null, acceptedAt: null, revokedAt: null },
          data: { revokedAt: now },
        });
        const invitation = await tx.staffInvitation.create({
          data: {
            organizationId: organization.id,
            email: input.adminEmail,
            role: 'ADMIN',
            tokenHash: hashToken(token),
            expiresAt,
            invitedByUserId: null,
          },
        });
        await tx.auditEvent.create({
          data: {
            organizationId: organization.id,
            actorType: 'SYSTEM',
            actorUserId: null,
            action: 'organization.bootstrapped',
            resourceType: 'organization',
            resourceId: organization.id,
            metadata: { organizationCreated, invitationId: invitation.id, role: 'ADMIN', revokedInvitations: revoked.count },
            correlationId,
          },
        });
        return { organization, organizationCreated, invitation, revokedInvitations: revoked.count };
      });
      return {
        organizationId: outcome.organization.id,
        slug: outcome.organization.slug,
        organizationCreated: outcome.organizationCreated,
        invitationId: outcome.invitation.id,
        adminEmail: input.adminEmail,
        acceptUrl: `${this.config.WEB_ORIGIN}/accept-invitation?token=${encodeURIComponent(token)}`,
        expiresAt: expiresAt.toISOString(),
        revokedInvitations: outcome.revokedInvitations,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DomainError('BOOTSTRAP_REFUSED', `Organization "${input.slug}" was created concurrently; run the command again`);
      }
      throw error;
    }
  }
}
