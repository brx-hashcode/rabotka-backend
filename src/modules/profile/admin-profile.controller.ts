import { Controller, Get, Patch, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { ProfileService } from './profile.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminListProfilesDto } from './dto/admin-list-profiles.dto';
import { AdminVerifyProfileDto } from './dto/admin-verify-profile.dto';
import { AdminUpdateStatusDto } from './dto/admin-update-status.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@ApiTags('Admin – Profiles')
@Controller('admin/profiles')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get()
  @ApiOperation({
    summary: 'List profiles (admin only)',
    description: 'Returns paginated profiles with optional search and filters.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of profiles' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async list(@Query() dto: AdminListProfilesDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    return await this.profileService.getProfilesForAdmin({
      page,
      limit,
      q: dto.q,
      status: dto.status,
      profileType: dto.profile_type,
      whatsappConnected: dto.whatsapp_connected,
      verificationStatus: dto.verification_status,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get profile details (admin only)',
    description: 'Returns full profile details including KYC documents.',
  })
  @ApiResponse({ status: 200, description: 'Profile details' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async getById(@Param('id') id: string) {
    return await this.profileService.getProfileDetailForAdmin(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update profile fields (admin only)',
    description: 'Updates profile fields like name, description, address.',
  })
  @ApiResponse({ status: 200, description: 'Updated profile details' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async update(@Param('id') id: string, @Body() dto: UpdateProfileDto) {
    return await this.profileService.updateProfileByAdmin(id, dto);
  }

  @Patch(':id/verify')
  @ApiOperation({
    summary: 'Verify or reject profile KYC (admin only)',
    description: 'Approves or rejects KYC verification for a profile and its documents.',
  })
  @ApiResponse({ status: 200, description: 'Updated profile details' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async verify(
    @Param('id') id: string,
    @Body() dto: AdminVerifyProfileDto,
    @Req() req: any,
  ) {
    const adminUserId = req.user?.userId ?? 'system';
    return await this.profileService.verifyProfileKyc(
      id,
      adminUserId,
      dto.decision,
      dto.reason,
    );
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Update profile account status (admin only)',
    description: 'Changes the account status (ACTIVE, SUSPENDED, BANNED, etc.).',
  })
  @ApiResponse({ status: 200, description: 'Updated profile details' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async updateStatus(@Param('id') id: string, @Body() dto: AdminUpdateStatusDto) {
    return await this.profileService.updateProfileStatusByAdmin(id, dto.status);
  }
}
