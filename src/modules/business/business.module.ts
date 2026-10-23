import { Module } from '@nestjs/common';
import { BusinessCatalogController } from './business-catalog.controller';

/** Business accounts: the public catalog for now; the dashboard routes join it. */
@Module({
  controllers: [BusinessCatalogController],
})
export class BusinessModule {}
