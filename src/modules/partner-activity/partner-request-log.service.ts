import {
  HttpException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import {
  IdentityCheckStatus,
  PartnerApiCallKind,
  Prisma,
  VerificationStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QueueService } from '../../common/services/queue/queue.service';
import { PARTNER_ACTIVITY_QUEUE } from '../../common/services/queue/queue.module';
import { OAuthError } from '../oauth/oauth-error';
import { readClientCredentials } from '../oauth/utils/client-credentials.util';
import type { PartnerLogRequest } from './partner-api-call.decorator';
import {
  summarizeError,
  summarizeRequest,
  summarizeResponse,
} from './summaries';

export const REQUEST_LOG_RETENTION_DAYS = 90;
export const TIMELINE_DAYS = 30;
const PRUNE_BATCH = 5_000;
const PRUNE_MAX_BATCHES = 40;

type PruneJob = { type: 'prune' };

export type RecordParams = {
  kind: PartnerApiCallKind;
  req: PartnerLogRequest;
  startedAt: number;
} & (
  | { statusCode: number; body: unknown; error?: undefined }
  | { error: unknown; statusCode?: undefined; body?: undefined }
);

export type PartnerAppStats = {
  signIns: number;
  identityChecks: {
    total: number;
    completed: number;
    notCompleted: number;
    pending: number;
  };
  connectedPeople: number;
  verifiedConnected: number;
  verifiedByCheck: number;
  timeline: { date: string; signIns: number; identityChecks: number }[];
};

export type PartnerRequestItem = {
  id: string;
  kind: PartnerApiCallKind;
  statusCode: number;
  outcome: string;
  durationMs: number;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  createdAt: string;
};

@Injectable()
export class PartnerRequestLogService implements OnModuleInit {
  private readonly logger = new Logger(PartnerRequestLogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queueService
        .getQueue(PARTNER_ACTIVITY_QUEUE)
        .add('partner-activity-prune', { type: 'prune' } satisfies PruneJob, {
          repeat: { pattern: '45 3 * * *' },
        });
    } catch (err) {
      this.logger.error(
        'Failed to register the partner activity clean-up — the log will grow until this is fixed',
        err,
      );
    }

    this.queueService.createWorker<PruneJob>(
      PARTNER_ACTIVITY_QUEUE,
      async () => {
        await this.prune();
      },
      { concurrency: 1 },
    );
  }

  record(params: RecordParams): void {
    void this.write(params).catch((err: unknown) => {
      this.logger.warn(
        `Could not record a ${params.kind} call: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  private async write(params: RecordParams): Promise<void> {
    const appId = await this.resolveAppId(params.req);
    if (!appId) return;

    const { req, kind } = params;
    const request = summarizeRequest(
      kind,
      req.body,
      req.params as Record<string, string | undefined>,
    );

    let statusCode: number;
    let outcome: string;
    let response: Record<string, unknown>;

    if (params.statusCode !== undefined) {
      statusCode = params.statusCode;
      outcome = 'ok';
      response = summarizeResponse(kind, params.body);
    } else {
      const failure = describeError(params.error);
      statusCode = failure.status;
      outcome = failure.code;
      response = summarizeError(failure.code, failure.description);
    }

    await this.prisma.partnerApiRequest.create({
      data: {
        app_id: appId,
        kind,
        status_code: statusCode,
        outcome,
        duration_ms: Math.max(0, Date.now() - params.startedAt),
        request: request as Prisma.InputJsonValue,
        response: response as Prisma.InputJsonValue,
      },
    });
  }

  private async resolveAppId(req: PartnerLogRequest): Promise<string | null> {
    if (req.partnerApp?.id) return req.partnerApp.id;

    const clientId =
      req.partnerClientId ??
      readClientCredentials(req, asCredentials(req.body)).clientId;
    if (!clientId) return null;

    const app = await this.prisma.oAuthApp.findFirst({
      where: { client_id: clientId },
      select: { id: true },
    });
    return app?.id ?? null;
  }

  async list(
    appId: string,
    params: { page: number; limit: number; kind?: PartnerApiCallKind },
  ): Promise<{ data: PartnerRequestItem[]; total: number }> {
    const where: Prisma.PartnerApiRequestWhereInput = {
      app_id: appId,
      ...(params.kind ? { kind: params.kind } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.partnerApiRequest.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      this.prisma.partnerApiRequest.count({ where }),
    ]);

    return {
      total,
      data: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        statusCode: row.status_code,
        outcome: row.outcome,
        durationMs: row.duration_ms,
        request: row.request as Record<string, unknown>,
        response: row.response as Record<string, unknown>,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async stats(appId: string, now = new Date()): Promise<PartnerAppStats> {
    const since = startOfDayUtc(
      new Date(now.getTime() - (TIMELINE_DAYS - 1) * 86_400_000),
    );

    const [
      signIns,
      checksByStatus,
      connectedPeople,
      verifiedConnected,
      verifiedByCheck,
      signInDays,
      checkDays,
    ] = await Promise.all([
      this.prisma.partnerApiRequest.count({
        where: {
          app_id: appId,
          kind: PartnerApiCallKind.TOKEN,
          outcome: 'ok',
        },
      }),
      this.prisma.identityCheck.groupBy({
        by: ['status'],
        where: { app_id: appId },
        _count: { _all: true },
      }),
      this.prisma.oAuthAuthorization.count({
        where: { app_id: appId, revoked_at: null },
      }),
      this.prisma.oAuthAuthorization.count({
        where: {
          app_id: appId,
          revoked_at: null,
          profile: { verification_status: VerificationStatus.VERIFIED },
        },
      }),
      this.prisma.identityCheck.count({
        where: {
          app_id: appId,
          status: IdentityCheckStatus.COMPLETED,
          result: { path: ['kyc', 'status'], equals: 'verified' },
        },
      }),
      this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day, count(*) AS count
        FROM partner_api_requests
        WHERE app_id = ${appId}::uuid
          AND kind = 'TOKEN'
          AND outcome = 'ok'
          AND created_at >= ${since}
        GROUP BY day`,
      this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day, count(*) AS count
        FROM identity_checks
        WHERE app_id = ${appId}::uuid
          AND created_at >= ${since}
        GROUP BY day`,
    ]);

    const statusCount = (status: IdentityCheckStatus) =>
      checksByStatus.find((row) => row.status === status)?._count._all ?? 0;
    const completed = statusCount(IdentityCheckStatus.COMPLETED);
    const notCompleted = statusCount(IdentityCheckStatus.NOT_COMPLETED);
    const pending = statusCount(IdentityCheckStatus.PENDING_CONSENT);

    return {
      signIns,
      identityChecks: {
        total: completed + notCompleted + pending,
        completed,
        notCompleted,
        pending,
      },
      connectedPeople,
      verifiedConnected,
      verifiedByCheck,
      timeline: buildTimeline(since, signInDays, checkDays),
    };
  }

  async prune(now = new Date()): Promise<{ deleted: number }> {
    const cutoff = new Date(
      now.getTime() - REQUEST_LOG_RETENTION_DAYS * 86_400_000,
    );
    let deleted = 0;
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
      const rows = await this.prisma.partnerApiRequest.findMany({
        where: { created_at: { lt: cutoff } },
        select: { id: true },
        take: PRUNE_BATCH,
      });
      if (rows.length === 0) break;
      const result = await this.prisma.partnerApiRequest.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      });
      deleted += result.count;
      if (rows.length < PRUNE_BATCH) break;
    }
    return { deleted };
  }
}

/** The status and code a partner actually received for a failed call. */
export function describeError(error: unknown): {
  status: number;
  code: string;
  description: unknown;
} {
  if (error instanceof OAuthError) {
    return {
      status: error.status,
      code: error.code,
      description: error.description,
    };
  }
  if (error instanceof HttpException) {
    const body = error.getResponse();
    const record =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : {};
    const code =
      typeof record.error === 'string' && /^[a-z_]+$/.test(record.error)
        ? record.error
        : error.getStatus() === 400
          ? 'invalid_request'
          : `http_${error.getStatus()}`;
    const message = Array.isArray(record.message)
      ? record.message.join(', ')
      : (record.error_description ?? record.message);
    return { status: error.getStatus(), code, description: message };
  }
  return { status: 500, code: 'server_error', description: null };
}

function asCredentials(body: unknown): {
  client_id?: string;
  client_secret?: string;
} {
  if (typeof body !== 'object' || body === null) return {};
  const b = body as Record<string, unknown>;
  return {
    client_id: typeof b.client_id === 'string' ? b.client_id : undefined,
  };
}

function startOfDayUtc(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function buildTimeline(
  since: Date,
  signIns: { day: Date; count: bigint }[],
  checks: { day: Date; count: bigint }[],
): PartnerAppStats['timeline'] {
  const key = (date: Date) => date.toISOString().slice(0, 10);
  const signInByDay = new Map(
    signIns.map((r) => [key(r.day), Number(r.count)]),
  );
  const checksByDay = new Map(checks.map((r) => [key(r.day), Number(r.count)]));

  return Array.from({ length: TIMELINE_DAYS }, (_, i) => {
    const date = key(new Date(since.getTime() + i * 86_400_000));
    return {
      date,
      signIns: signInByDay.get(date) ?? 0,
      identityChecks: checksByDay.get(date) ?? 0,
    };
  });
}
