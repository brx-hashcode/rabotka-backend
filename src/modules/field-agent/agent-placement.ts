import type { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import type { PrismaService } from '../../common/services/prisma/prisma.service';

/**
 * Tells the admins in the bell that an agent placed a worker — whether the
 * worker accepted the agent's invitation or the agent placed them directly.
 * Never throws: the placement is recorded; the bell is a courtesy.
 */
export async function notifyAgentPlacement(
  deps: { prisma: PrismaService; events: EventEmitter2 },
  p: {
    agentId: string | null;
    agentFirstName: string | null | undefined;
    jobTitle: string;
    workerId: string;
    applicationId: string;
  },
): Promise<void> {
  if (!p.agentId) return;
  try {
    const worker = await deps.prisma.profile.findUnique({
      where: { id: p.workerId },
      select: { first_name: true, last_name: true },
    });
    const workerName = worker
      ? `${worker.first_name} ${worker.last_name}`.trim()
      : 'un travailleur';
    deps.events.emit(AdminNotificationEvent.AGENT_PLACEMENT, {
      event: AdminNotificationEvent.AGENT_PLACEMENT,
      title: 'Nouveau placement agent',
      message: `${p.agentFirstName ?? 'Un agent'} a placé ${workerName} sur « ${p.jobTitle} »`,
      // The application, not the agent: that is what an admin opens next,
      // and its detail names the agent.
      entityType: 'agent-placement',
      entityId: p.applicationId,
      metadata: { agentId: p.agentId, workerId: p.workerId },
      timestamp: new Date().toISOString(),
    });
  } catch {
    // The placement is recorded; the bell is a courtesy.
  }
}
