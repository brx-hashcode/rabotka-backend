import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ProfileNotificationService } from './profile-notification.service';
import { ListProfileNotificationsDto } from './dto/list-profile-notifications.dto';

/**
 * A profile's notification feed as the admin sees it: the same rows the bell
 * shows, plus the actor the profile is never told about.
 *
 * Its own controller rather than another route on AdminProfileController, whose
 * constructor the specs build positionally.
 */
@ApiTags('Admin – Profiles')
@Controller('admin/profiles/:profileId/notifications')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminProfileNotificationController {
  constructor(private readonly service: ProfileNotificationService) {}

  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: "List a profile's in-app notifications" })
  @ApiResponse({ status: 200, description: 'Paginated notifications' })
  list(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Query() dto: ListProfileNotificationsDto,
  ) {
    return this.service.listForAdmin(profileId, dto.page ?? 1, dto.limit ?? 20);
  }
}
