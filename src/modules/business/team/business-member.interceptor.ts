import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable, from, mergeMap, tap } from 'rxjs';

import { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { AuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { memberMayCall, refusalFor, routePattern } from './team-access';
import { TeamService } from './team.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SEEN_EVERY_MS = 5 * 60_000;

/** The changes worth a line in « Activité »: hiring and the organisation. */
const LOGGED: RegExp[] = [
  /^\/business\/me(\/|$)/,
  /^\/job-offers(\/|$)/,
  /^\/profile\/job-offers(\/|$)/,
  /^\/profile\/applications(\/|$)/,
  /^\/profile\/avatar$/,
];
/** …but not one's own settings, or every question asked about a CV. */
const NOT_LOGGED: RegExp[] = [
  /^\/business\/me\/member$/,
  /^\/business\/me\/offer-drafts$/,
  /\/chat$/,
];

type Req = AuthenticatedRequest & {
  route?: { path?: string };
  baseUrl?: string;
  params?: Record<string, string>;
};

/**
 * Every request, after its guards. With a team member in the token (`mid`):
 * the member must still be active in the business the token acts as — so a
 * removal takes effect on the next call — and its role must allow the route
 * (`team-access.ts`). Then each successful change by the business, holder or
 * member, goes to its activity log.
 *
 * Global (APP_INTERCEPTOR) because the business space also calls shared
 * routes that BusinessProfileGuard never sees.
 */
@Injectable()
export class BusinessMemberInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly team: TeamService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Req>();
    const user = req.user;
    if (!user || user.type !== 'profile' || !user.profileId) {
      return next.handle();
    }
    return from(this.check(req, user.profileId, user.memberId)).pipe(
      mergeMap((actor) => {
        const method = req.method.toUpperCase();
        const path = routePattern(req);
        const logged =
          !READS.has(method) &&
          LOGGED.some((r) => r.test(path)) &&
          !NOT_LOGGED.some((r) => r.test(path));
        if (!logged) return next.handle();
        return next.handle().pipe(
          tap(() => {
            void this.log(user.profileId!, actor, method, path, req.params);
          }),
        );
      }),
    );
  }

  /** The member behind the token, checked; null for the holder or anyone else. */
  private async check(
    req: Req,
    profileId: string,
    memberId: string | undefined,
  ): Promise<{ businessId: string; memberId: string } | null> {
    if (!memberId) return null;
    const member = await this.prisma.businessMember.findUnique({
      where: { id: memberId },
      select: {
        id: true,
        role: true,
        status: true,
        last_seen_at: true,
        business_id: true,
        business: { select: { profile_id: true, deleted_at: true } },
      },
    });
    if (
      !member ||
      member.status !== 'ACTIVE' ||
      member.business.profile_id !== profileId ||
      member.business.deleted_at
    ) {
      throw new UnauthorizedException('Votre accès à cet espace a été retiré.');
    }
    if (!memberMayCall(member.role, req.method, routePattern(req))) {
      throw new ForbiddenException(refusalFor(member.role));
    }
    if (
      !member.last_seen_at ||
      Date.now() - member.last_seen_at.getTime() > SEEN_EVERY_MS
    ) {
      void this.prisma.businessMember
        .update({
          where: { id: member.id },
          data: { last_seen_at: new Date() },
        })
        .catch(() => undefined);
    }
    return { businessId: member.business_id, memberId: member.id };
  }

  private async log(
    profileId: string,
    actor: { businessId: string; memberId: string } | null,
    method: string,
    path: string,
    params: Record<string, string> | undefined,
  ): Promise<void> {
    try {
      let who = actor;
      if (!who) {
        // The holder, or someone who is not a business at all.
        const business = await this.prisma.business.findUnique({
          where: { profile_id: profileId },
          select: { id: true, deleted_at: true },
        });
        if (!business || business.deleted_at) return;
        const holder = await this.team.holder(business.id);
        who = { businessId: business.id, memberId: holder.id };
      }
      // The first id in the route: `applications/:kind/:id/…` names the
      // candidature second, after its kind (« rabotka », « external »).
      const values = Object.values(params ?? {});
      const target = values.find((v) => UUID.test(v)) ?? values[0] ?? null;
      await this.team.record(
        who.businessId,
        who.memberId,
        `${method} ${path}`,
        target,
      );
    } catch {
      // The change happened; a missing log line must not turn it into an error.
    }
  }
}
