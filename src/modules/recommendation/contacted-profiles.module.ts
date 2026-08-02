import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { ContactedProfilesService } from './contacted-profiles.service';

/**
 * A leaf module on purpose: the profile controller, the mobile feed and the
 * collaboration graph all need this, and importing RecommendationModule for it
 * would drag Bot and WhatsApp (already forwardRef'd into each other) along.
 */
@Module({
  imports: [PrismaModule],
  providers: [ContactedProfilesService],
  exports: [ContactedProfilesService],
})
export class ContactedProfilesModule {}
