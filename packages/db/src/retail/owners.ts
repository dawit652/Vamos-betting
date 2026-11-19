import { eq } from 'drizzle-orm';
import {
  createStaffUser,
  type CreateStaffUserResult,
  type StaffAuthDeps,
} from '../backoffice/staff-auth';
import { domainConflict, domainNotFound } from '../errors';
import { writeAudit } from '../platform/audit';
import { agents } from '../schema/retail';
import { getAgent } from './agents';

/** Audit action of an agent's owner account being made. */
export const AGENT_OWNER_ACCOUNT_CREATED = 'agent.owner_account_created';

const ownerExists = () =>
  domainConflict('agent_owner_exists', 'This agent already has an owner account.');

/**
 * Makes an agent's owner account (docs/plans/agent-shops.md, phase 1b step 1): role
 * `agent_owner`, the agent's owner name and phone, a generated password the owner must replace at
 * the first sign-in (it stops working after 72 hours otherwise) and an authenticator secret, both
 * shown once. The account is linked to the agent in the same transaction. Owners sign in to the
 * shop app only (password and authenticator code), never to the back office. 404 for an unknown
 * agent, 409 `agent_is_house` for Nahubet HQ (its people are staff), 409 `agent_owner_exists` when
 * the agent has one already, 409 `staff_email_taken` for an email in use.
 */
export async function createAgentOwnerAccount(
  deps: StaffAuthDeps,
  input: { agentId: string; email: string; adminId: string; ip?: string | null },
): Promise<CreateStaffUserResult> {
  const agent = await getAgent(deps.db, input.agentId);
  if (agent === null) throw domainNotFound('Agent');
  if (agent.isHouse) {
    throw domainConflict(
      'agent_is_house',
      'Nahubet HQ has no owner account: its people use the back office.',
    );
  }
  if (agent.ownerStaffId !== null) throw ownerExists();
  return createStaffUser(deps, {
    email: input.email,
    displayName: agent.ownerName,
    role: 'agent_owner',
    phone: agent.ownerPhone,
    actor: { type: 'admin', adminId: input.adminId, ip: input.ip ?? null },
    inTransaction: async (tx, user) => {
      // Under the agent's row lock: two admins making an owner at once link exactly one.
      const [locked] = await tx
        .select({ ownerStaffId: agents.ownerStaffId })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .for('update');
      if (!locked) throw domainNotFound('Agent');
      if (locked.ownerStaffId !== null) throw ownerExists();
      await tx
        .update(agents)
        .set({ ownerStaffId: user.id, updatedAt: deps.clock() })
        .where(eq(agents.id, agent.id));
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: input.adminId,
        action: AGENT_OWNER_ACCOUNT_CREATED,
        targetType: 'agent',
        targetId: agent.id,
        metadata: { staffId: user.id, email: user.email },
        ip: input.ip ?? null,
      });
    },
  });
}
