import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiCookieAuth,
  ApiBearerAuth,
  ApiResponse,
} from '@nestjs/swagger';
import { ContractService } from './contract.service';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';

@ApiTags('Contracts')
@Controller('contracts')
@UseGuards(ProfileAuthGuard)
@ApiCookieAuth()
@ApiBearerAuth()
export class ContractController {
  constructor(private readonly contractService: ContractService) {}

  @Get(':contractId/download')
  @ApiOperation({
    summary: 'Download a contract PDF (worker or employer only)',
  })
  @ApiResponse({ status: 200, description: 'PDF file stream' })
  @ApiResponse({ status: 403, description: 'Not authorized' })
  @ApiResponse({ status: 404, description: 'Contract or template not found' })
  async download(
    @Param('contractId') contractId: string,
    @Req() req: ProfileAuthenticatedRequest,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.contractService.download(
      contractId,
      req.user.profileId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}

@ApiTags('Admin – Contracts')
@Controller('admin/contracts')
@UseGuards(AdminAuthGuard)
@ApiCookieAuth()
@ApiBearerAuth()
export class AdminContractController {
  constructor(private readonly contractService: ContractService) {}

  @Get(':contractId/download')
  @ApiOperation({ summary: 'Download a contract PDF (admin)' })
  @ApiResponse({ status: 200, description: 'PDF file stream' })
  @ApiResponse({ status: 404, description: 'Contract or template not found' })
  async download(
    @Param('contractId') contractId: string,
    @Res() res: Response,
  ) {
    const { buffer, filename } =
      await this.contractService.downloadAsAdmin(contractId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}
