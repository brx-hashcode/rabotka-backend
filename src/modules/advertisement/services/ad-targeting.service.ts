import { Injectable, Logger } from '@nestjs/common';
import { Profile, ProfileType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';

type AdForTargeting = {
  id: string;
  bundle: {
    max_reach: number;
    target_audience: string;
  };
};

@Injectable()
export class AdTargetingService {
  private readonly logger = new Logger(AdTargetingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveRecipients(
    advertisement: AdForTargeting,
  ): Promise<
    Pick<
      Profile,
      | 'id'
      | 'first_name'
      | 'last_name'
      | 'email'
      | 'phone'
      | 'whatsapp_connected'
    >[]
  > {
    const audience = advertisement.bundle.target_audience;
    let profileTypes: ProfileType[];
    if (audience === 'WORKER') {
      profileTypes = [ProfileType.WORKER];
    } else if (audience === 'EMPLOYER') {
      profileTypes = [ProfileType.EMPLOYER];
    } else {
      profileTypes = [ProfileType.WORKER, ProfileType.EMPLOYER];
    }

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    // Profiles already sent this ad today — exclude them to prevent re-delivery
    const alreadySentRows = await this.prisma.$queryRaw<
      { profile_id: string }[]
    >`
      SELECT DISTINCT profile_id::text
      FROM "ad_delivery_logs"
      WHERE advertisement_id = ${advertisement.id}::uuid
        AND sent_at >= ${todayStart}
    `;
    const excludedIds = alreadySentRows.map((r) => r.profile_id);

    const excludedIdsLiteral =
      excludedIds.length > 0
        ? Prisma.sql`AND p.id NOT IN (${Prisma.join(excludedIds.map((id) => Prisma.sql`${id}::uuid`))})`
        : Prisma.empty;

    const profileTypesLiteral = Prisma.join(
      profileTypes.map(
        (t) => Prisma.sql`${Prisma.raw(`'${t}'::"ProfileType"`)}`,
      ),
    );

    const profiles = await this.prisma.$queryRaw<
      Pick<
        Profile,
        | 'id'
        | 'first_name'
        | 'last_name'
        | 'email'
        | 'phone'
        | 'whatsapp_connected'
      >[]
    >`
      SELECT p.id, p.first_name, p.last_name, p.email, p.phone, p.whatsapp_connected
      FROM profiles p
      WHERE p.status = 'ACTIVE'::"AccountStatus"
        AND p.profile_type IN (${profileTypesLiteral})
        ${excludedIdsLiteral}
      ORDER BY RANDOM()
      LIMIT ${advertisement.bundle.max_reach}
    `;

    this.logger.debug(
      `Resolved ${profiles.length} recipients for advertisement ${advertisement.id}`,
    );

    return profiles;
  }
}
