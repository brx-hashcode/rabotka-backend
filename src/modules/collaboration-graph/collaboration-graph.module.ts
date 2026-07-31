import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CollaborationGraphController } from './collaboration-graph.controller';
import { CollaborationGraphService } from './collaboration-graph.service';

/**
 * AuthModule is imported for AdminAuthGuard's own dependencies (JwtService,
 * REDIS_CONNECTION); forwardRef mirrors DashboardModule, which guards the same
 * way. Without it the whole app fails to boot, not just this route.
 */
@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule)],
  controllers: [CollaborationGraphController],
  providers: [CollaborationGraphService],
  exports: [CollaborationGraphService],
})
export class CollaborationGraphModule {}
