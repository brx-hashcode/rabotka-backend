import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import {
  BusinessApplicationCvController,
  ProfileCvController,
} from './profile-cv.controller';
import { ProfileCvService } from './profile-cv.service';

/** « Mon CV »: a worker's own CV, and the business's way to read it. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [ConfigModule, forwardRef(() => AuthModule)],
  controllers: [ProfileCvController, BusinessApplicationCvController],
  providers: [ProfileCvService],
  exports: [ProfileCvService],
})
export class ProfileCvModule {}
