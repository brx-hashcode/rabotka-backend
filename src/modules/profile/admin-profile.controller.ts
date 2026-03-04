import { Controller, Get, Query, UseGuards } from '@nestjs/common';
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
    description:
      'Returns paginated profiles with optional search (first_name, last_name, email, phone) and filters: status, profile_type, whatsapp_connected, verification_status.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of profiles',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              email: { type: 'string' },
              phone: { type: 'string' },
              address: { type: 'string' },
              description: { type: 'string' },
              status: { type: 'string' },
              profileType: { type: 'string' },
              whatsappConnected: { type: 'boolean' },
              verificationStatus: { type: 'string' },
              verifiedBy: { type: 'string', format: 'uuid', nullable: true },
              verifiedAt: { type: 'string', format: 'date-time', nullable: true },
              rejectionReason: { type: 'string', nullable: true },
              reliabilityScore: { type: 'number', nullable: true },
              avatarUrl: { type: 'string', nullable: true },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        total: { type: 'number' },
        page: { type: 'number' },
        limit: { type: 'number' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async list(@Query() dto: AdminListProfilesDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    return this.profileService.getProfilesForAdmin({
      page,
      limit,
      q: dto.q,
      status: dto.status,
      profileType: dto.profile_type,
      whatsappConnected: dto.whatsapp_connected,
      verificationStatus: dto.verification_status,
    });
  }
}
