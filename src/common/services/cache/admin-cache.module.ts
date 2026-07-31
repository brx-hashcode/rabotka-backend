import { Global, Module } from '@nestjs/common';
import { AdminCacheService } from './admin-cache.service';

/**
 * Global so any admin list/dashboard service can cache without each feature
 * module re-importing it. REDIS_CONNECTION is already global via
 * RedisModule.forRoot(), so this adds no wiring of its own.
 */
@Global()
@Module({
  providers: [AdminCacheService],
  exports: [AdminCacheService],
})
export class AdminCacheModule {}
