import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
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
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';
import { AdminProfileChatService } from './admin-profile-chat.service';
import { AdminListConversationMessagesDto } from './dto/admin-list-conversation-messages.dto';

/**
 * TIER TWO: the messages themselves.
 *
 * ON ITS OWN CONTROLLER, and that is the whole point of the file existing
 * rather than one more handler next door. `LATERAL_ACCESS` is keyed by
 * controller PREFIX, so a lateral role granted `admin/conversations` would
 * otherwise reach this too — `LATERAL_CEILING` caps SUPPORT at MANAGER, which
 * is exactly the level this endpoint asks for, so seniority cannot separate
 * them. A separate prefix can. The repo already does this for the claim
 * comments: "Its own controller, so its own key" (`lateral-access.ts`).
 *
 * Absent from `LATERAL_ACCESS` entirely, so it fails closed for FINANCE and
 * SUPPORT until somebody adds a line on purpose.
 *
 * Every read writes one `Log` row. That is not telemetry here, it is the
 * permission model: the tier exists because reading two people's private
 * conversation should cost something, and leaving a trace is the cost.
 */
@ApiTags('Admin – Conversations')
@Controller('admin/conversations/thread')
@UseGuards(AdminAuthGuard, RolesGuard)
@Roles(UserRole.MANAGER)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminConversationThreadController {
  constructor(
    private readonly conversations: AdminProfileChatService,
    private readonly logService: LogService,
  ) {}

  // NOTE: comments must stay ABOVE the decorator block, never between the
  // decorators and the handler — `admin-routes.contract.spec.ts` scans the
  // source for a `@Roles` on every admin handler and a comment in the middle
  // hides it.
  @Get(':id/messages')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Read a thread, raw',
    description:
      'Returns every message the conversation has ever held — including ones withheld whole, which were never delivered and exist nowhere else — with the original text and the offsets of what was cut out of it. Newest first, like the end-user endpoint. Each call is recorded in the activity log.',
  })
  @ApiResponse({ status: 200, description: 'Paginated messages' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async messages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() dto: AdminListConversationMessagesDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const thread = await this.conversations.messages(id, dto.page, dto.limit);

    // AFTER the read and only on success: a 404 is not a disclosure, and
    // logging one would turn this trail into a probe log.
    //
    // AWAITED, not fire-and-forget. The log row is the permission model, so a
    // read whose row cannot be written must fail rather than quietly happen
    // unrecorded. It is one insert on the connection the read just used.
    //
    // NO MESSAGE TEXT IN THE METADATA, ever. The whole feature exists to keep
    // contact details out of circulation; copying a body into a table that
    // support staff can list would put them straight back in.
    await this.logService.create({
      action: 'CONVERSATION_THREAD_READ',
      entityType: 'ProfileConversation',
      entityId: id,
      userId: req.user.userId,
      metadata: {
        page: dto.page ?? 1,
        returned: thread.data.length,
        total: thread.total,
        workerId: thread.workerId,
        employerId: thread.employerId,
      },
      ...extractRequestMeta(req),
    });

    return thread;
  }
}
