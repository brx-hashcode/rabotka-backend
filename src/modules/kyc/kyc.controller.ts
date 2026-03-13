import { Controller, Post, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { KycService } from './kyc.service';

@Controller('kyc')
export class KycController {
  constructor(private readonly kycService: KycService) {}

  @Post(':profileId/approve')
  @HttpCode(HttpStatus.OK)
  async approveKyc(@Param('profileId') profileId: string): Promise<{ ok: boolean }> {
    await this.kycService.approveKyc(profileId);
    return { ok: true };
  }
}
