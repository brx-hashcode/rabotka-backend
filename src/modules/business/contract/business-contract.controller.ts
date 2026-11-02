import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { BusinessContractService } from './business-contract.service';

/** « Télécharger le contrat » for a retained candidate. */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/applications')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class BusinessContractController {
  constructor(private readonly contracts: BusinessContractService) {}

  @Get(':applicationId/contract.pdf')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'The contract of a retained candidate (PDF), made if missing',
    description:
      'Only for an application to one of the business’s offers, once retained (accepted, started or ended); 400 before, 404 for another business’s.',
  })
  async contract(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.contracts.pdf(
      req.user.profileId,
      applicationId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', attachment(filename));
    res.send(buffer);
  }
}

/**
 * A header carries ASCII only: an accented name (« Facturée ») arrived
 * garbled. The plain name for every browser, the exact one for those that
 * read `filename*`.
 */
export function attachment(filename: string): string {
  const plain = filename
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
