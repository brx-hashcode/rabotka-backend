import { Module, forwardRef } from '@nestjs/common';
import {
  InvoiceController,
  AdminInvoiceController,
} from './invoice.controller';
import { InvoiceService } from './invoice.service';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { DocumentModule } from '../document/document.module';

@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule), DocumentModule],
  controllers: [InvoiceController, AdminInvoiceController],
  providers: [InvoiceService],
  exports: [InvoiceService],
})
export class InvoiceModule {}
