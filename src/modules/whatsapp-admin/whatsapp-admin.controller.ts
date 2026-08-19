import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { WhatsappAdminService } from './whatsapp-admin.service';
import {
  AdminListWhatsappMessagesDto,
  AdminWhatsappRangeDto,
} from './dto/admin-list-whatsapp-messages.dto';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';

@ApiTags('Admin – WhatsApp')
@Controller('admin/whatsapp')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class WhatsappAdminController {
  constructor(
    private readonly service: WhatsappAdminService,
    private readonly logService: LogService,
  ) {}

  // MANAGER, not MODERATOR: the delivery log carries message bodies and
  // recipient numbers for every user on the platform.
  @Get('messages')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'List WhatsApp messages with their delivery status',
    description:
      'Every outbound send, with recipient, template, content and the ' +
      'furthest delivery state it reached.',
  })
  @ApiResponse({ status: 200, description: 'Paginated delivery log' })
  async listMessages(@Query() dto: AdminListWhatsappMessagesDto) {
    return this.service.listForAdmin({
      page: dto.page ?? 1,
      limit: dto.limit ?? 20,
      q: dto.q,
      status: dto.status,
      template_key: dto.template_key,
      kind: dto.kind,
      direction: dto.direction,
      provider: dto.provider,
      profile_id: dto.profile_id,
      created_from: dto.created_from,
      created_to: dto.created_to,
    });
  }

  @Get('stats')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Delivery statistics for a window',
    description:
      'Counts by status, delivery/read/failure rates, a daily timeline, ' +
      'per-template performance and the most frequent errors.',
  })
  async stats(@Query() dto: AdminWhatsappRangeDto) {
    return this.service.statsForAdmin({
      created_from: dto.created_from,
      created_to: dto.created_to,
    });
  }

  @Get('billing')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'WhatsApp consumption and approximate cost, from Meta',
    description:
      'Volume and approximate cost per day from the WhatsApp Business ' +
      'Account, by category and country. This is what was CONSUMED — Meta ' +
      'exposes no balance or amount-due endpoint for a directly-billed ' +
      'account, and cost is omitted entirely for partner-billed accounts.',
  })
  @ApiResponse({
    status: 503,
    description:
      'The active provider is not Meta Cloud, or Graph is unreachable',
  })
  async billing(@Query() dto: AdminWhatsappRangeDto) {
    return this.service.billingForAdmin({
      created_from: dto.created_from,
      created_to: dto.created_to,
    });
  }

  @Get('queue')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Outbound queue and dead-letter queue snapshot',
    description:
      'Job counts for the WhatsApp outbound queue plus the contents of its ' +
      'dead-letter queue, which has no consumer and is otherwise invisible.',
  })
  async queue() {
    return this.service.queueSnapshot();
  }

  @Post('queue/dlq/:jobId/retry')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Re-enqueue a dead-lettered send',
    description:
      'Pushes the original job payload back onto the outbound queue and ' +
      'removes the dead-letter entry.',
  })
  async retryDlqJob(
    @Param('jobId') jobId: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const result = await this.service.retryDlqJob(jobId);

    if (result.retried) {
      await this.logService.create({
        action: 'WHATSAPP_DLQ_JOB_RETRIED',
        entityType: 'WhatsappMessage',
        entityId: jobId,
        userId: req.user?.userId,
        metadata: { jobId },
        ...extractRequestMeta(req),
      });
    }

    return result;
  }
}
