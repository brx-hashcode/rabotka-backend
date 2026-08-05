import { Global, Module } from '@nestjs/common';
import { GeoService } from './geo.service';
import { GeoPublicController } from './geo-public.controller';

/**
 * Global because the reference list is needed wherever a location is written —
 * profile creation, profile updates, the admin edit form — and the service
 * holds nothing but an already-parsed JSON file, so there is no cost to it
 * being available everywhere.
 */
@Global()
@Module({
  providers: [GeoService],
  controllers: [GeoPublicController],
  exports: [GeoService],
})
export class GeoModule {}
