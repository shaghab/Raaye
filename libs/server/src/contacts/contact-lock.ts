import { notFound } from '../common/errors';
import type { Contact } from '../persistence/prisma.service';
import type { TenantTx } from '../persistence/tenant-db';

/**
 * Row lock on a contact, held until the transaction ends, and the row as the lock finds it.
 * Consent decisions (staff grants and withdrawals, STOP, import attestation), archive, phone
 * changes, the processing of an inbound message and the hand-off to the provider all take this
 * lock before they read or change anything about the contact, so each one reads the permission
 * state the previous decision left, and a withdrawal's cancellation sees every reply the
 * processing of an inbound message queued. The tenant-scoped read proves the contact belongs to
 * the organization before the raw lock statement runs.
 */
export async function lockContact(tx: TenantTx, contactId: string): Promise<Contact> {
  const scoped = await tx.contact.findUnique({ where: { id: contactId }, select: { id: true, organizationId: true } });
  if (!scoped) throw notFound('Contact');
  await tx.$queryRaw`SELECT id FROM contacts WHERE id = ${scoped.id}::uuid AND organization_id = ${scoped.organizationId}::uuid FOR UPDATE`;
  // Read again once the lock is held: a decision that held it until a moment ago has committed.
  return tx.contact.findUniqueOrThrow({ where: { id: contactId } });
}
