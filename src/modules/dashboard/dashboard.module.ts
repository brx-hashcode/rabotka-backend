import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { DashboardService } from './dashboard.service';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule)],
  controllers: [AdminDashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
