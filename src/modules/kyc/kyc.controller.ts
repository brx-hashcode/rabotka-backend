import {
  Controller,
  Post,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { KycService } from './kyc.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Prefixed `admin/` and guarded like every other staff surface.
 *
 * It was neither. The controller carried no `@UseGuards` at all and sat at the
 * bare root, and because this app registers no global auth guard, that made
 * `POST /api/v1/kyc/<id>/approve` reachable by anyone on the internet — for any
 * profile id they could guess or enumerate from the 404/200 difference. Each
 * call sends a real, billable WhatsApp template telling that person their
 * identity check was approved.
 *
 * MANAGER matches the sibling that does the same job through the profile API,
 * `PATCH admin/profiles/:id/verify`. Two ways to assert somebody's identity
 * should not sit at two different levels of trust.
 */
@ApiTags('KYC')
@Controller('admin/kyc')
@UseGuards(AdminAuthGuard, RolesGuard)
export class KycController {
  constructor(private readonly kycService: KycService) {}

  @Post(':profileId/approve')
  @Roles(UserRole.MANAGER)
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
