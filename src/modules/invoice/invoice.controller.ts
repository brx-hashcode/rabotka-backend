import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiCookieAuth,
  ApiBearerAuth,
  ApiResponse,
} from '@nestjs/swagger';
import { InvoiceService } from './invoice.service';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';

@ApiTags('Invoices')
@Controller('invoices')
@UseGuards(ProfileAuthGuard)
@ApiCookieAuth()
@ApiBearerAuth()
export class InvoiceController {
  constructor(private readonly invoiceService: InvoiceService) {}

  @Get()
  @ApiOperation({ summary: 'List all invoices for the authenticated profile' })
  @ApiResponse({ status: 200, description: 'List of invoices' })
  async list(@Req() req: ProfileAuthenticatedRequest) {
    return this.invoiceService.listForProfile(req.user.profileId);
  }

  @Get(':invoiceId/download')
  @ApiOperation({ summary: 'Download an invoice PDF (owner only)' })
  @ApiResponse({ status: 200, description: 'PDF file stream' })
  @ApiResponse({ status: 403, description: 'Not authorized' })
  @ApiResponse({ status: 404, description: 'Invoice or template not found' })
  async download(
    @Param('invoiceId') invoiceId: string,
    @Req() req: ProfileAuthenticatedRequest,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.invoiceService.download(
      invoiceId,
      req.user.profileId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Post(':invoiceId/send-whatsapp')
  @HttpCode(200)
  // Each send is a billable WhatsApp message: a few retries, not a loop.
  @Throttle({ default: { limit: 5, ttl: 10 * 60_000 } })
  @ApiOperation({
    summary: "Send an invoice PDF to the owner's WhatsApp (owner only)",
    description:
      "Sent to the profile's own number only. 503 when WhatsApp document delivery is off or unsupported by the provider.",
  })
  @ApiResponse({ status: 200, description: 'Sent' })
  @ApiResponse({ status: 403, description: 'Not authorized' })
  @ApiResponse({ status: 503, description: 'Document delivery unavailable' })
  async sendWhatsApp(
    @Param('invoiceId') invoiceId: string,
    @Req() req: ProfileAuthenticatedRequest,
  ) {
    return this.invoiceService.sendToWhatsApp(invoiceId, req.user.profileId);
  }
}

@ApiTags('Admin – Invoices')
@Controller('admin/invoices')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiCookieAuth()
@ApiBearerAuth()
export class AdminInvoiceController {
  constructor(private readonly invoiceService: InvoiceService) {}

  // Counterparty identity and amounts, same as the contract download.
  @Get(':invoiceId/download')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Download an invoice PDF (admin)' })
  @ApiResponse({ status: 200, description: 'PDF file stream' })
  @ApiResponse({ status: 404, description: 'Invoice or template not found' })
  async download(@Param('invoiceId') invoiceId: string, @Res() res: Response) {
    const { buffer, filename } =
      await this.invoiceService.downloadAsAdmin(invoiceId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}
