import { Injectable, Logger } from '@nestjs/common';
import {
  AccountStatus,
  Profile,
  ProfileType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';

type AdForTargeting = {
  id: string;
  bundle: {
    max_reach: number;
  };
};

@Injectable()
export class AdTargetingService {
  private readonly logger = new Logger(AdTargetingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveRecipients(
    advertisement: AdForTargeting,
  ): Promise<Pick<Profile, 'id' | 'first_name' | 'last_name' | 'email' | 'phone'>[]> {
    const where: Prisma.ProfileWhereInput = {
      status: AccountStatus.ACTIVE,
      // Target all profile types — bundle-level targeting only by reach cap
      profile_type: { in: [ProfileType.WORKER, ProfileType.EMPLOYER] },
    };

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
      take: advertisement.bundle.max_reach,
    });

    this.logger.debug(
      `Resolved ${profiles.length} recipients for advertisement ${advertisement.id}`,
    );

    return profiles;
  }
}
