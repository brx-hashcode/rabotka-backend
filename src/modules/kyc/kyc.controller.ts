import { Controller, Post, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { KycService } from './kyc.service';

@ApiTags('KYC')
@Controller('kyc')
export class KycController {
  constructor(private readonly kycService: KycService) {}

  @Post(':profileId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin: approve KYC and send WhatsApp verification link',
  })
  @ApiResponse({
    status: 200,
    description: 'Verification link sent via WhatsApp',
  })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async approveKyc(
    @Param('profileId') profileId: string,
  ): Promise<{ ok: boolean }> {
    await this.kycService.approveKyc(profileId);
    return { ok: true };
  }
}
