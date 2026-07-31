import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { ArchiveService } from './archive.service';

/**
 * Restore / permanent-delete for soft-deleted admin rows. Depends only on
 * Prisma: the per-entity rules are data (ARCHIVE_REGISTRY), not services, so
 * this imports none of the feature modules and can be pulled in anywhere.
 */
@Module({
  imports: [PrismaModule],
  providers: [ArchiveService],
  exports: [ArchiveService],
})
export class AdminArchiveModule {}
