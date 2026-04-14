import { Injectable, Logger } from '@nestjs/common';
import {
  AccountStatus,
  Advertisement,
  Profile,
  ProfileType,
  TargetAudience,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';

@Injectable()
export class AdTargetingService {
  private readonly logger = new Logger(AdTargetingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveRecipients(
    advertisement: Advertisement,
  ): Promise<Pick<Profile, 'id' | 'first_name' | 'last_name' | 'email' | 'phone'>[]> {
    const where: Prisma.ProfileWhereInput = {
      status: AccountStatus.ACTIVE,
    };

    if (advertisement.target_audience !== TargetAudience.BOTH) {
      where.profile_type =
        advertisement.target_audience === TargetAudience.WORKERS
          ? ProfileType.WORKER
          : ProfileType.EMPLOYER;
    }

    // targetFilters (sectors, cities, etc.) are stored for future use
    // Profile doesn't have sector/city fields yet — filtering is by profile_type only for now

    const profiles = await this.prisma.profile.findMany({
      where,
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        phone: true,
      },
      orderBy: { created_at: 'desc' },
      take: advertisement.target_reach,
    });

    this.logger.debug(
      `Resolved ${profiles.length} recipients for advertisement ${advertisement.id}`,
    );

    return profiles;
  }
}
