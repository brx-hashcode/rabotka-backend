import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
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
import { AdminListConversationsDto } from './dto/admin-list-conversations.dto';

/**
 * The back-office view of user-to-user conversations — TIER ONE.
 *
 * Everything here is about a conversation without being about what was said in
 * it: who is talking to whom, how much, how often something had to be withheld,
 * whether anybody contested it. That is enough to answer most operational
 * questions — "this account sends 200 messages a day and 80% are redacted" is
 * read off the list without opening a single thread — and it is why this tier
 * sits at MODERATOR and is not logged.
 *
 * Reading the messages themselves is a different act with a different audience,
 * and it lives on its own controller. See `admin-profile-chat-thread.controller.ts`.
 */
@ApiTags('Admin – Conversations')
@Controller('admin/conversations')
@UseGuards(AdminAuthGuard, RolesGuard)
@Roles(UserRole.MODERATOR)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminConversationController {
  constructor(
    private readonly conversations: AdminProfileChatService,
    private readonly logService: LogService,
  ) {}

  // NOTE: comments must stay ABOVE the decorator block, never between the
  // decorators and the handler — `admin-routes.contract.spec.ts` scans the
  // source for a `@Roles` on every admin handler and a comment in the middle
  // hides it. See the same warning in `admin-contact-record.controller.ts`.
  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'List every conversation, newest activity first',
    description:
      'Carries no message text of any kind, deliberately: reading bodies is a separate, logged surface. Includes conversations in which every message was withheld whole — those have no `lastMessageAt`, sort last, and are reached with the HELD flag.',
  })
  @ApiResponse({ status: 200, description: 'Paginated conversations' })
  async list(@Query() dto: AdminListConversationsDto) {
    return this.conversations.list(dto);
  }

  @Get(':id')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'One conversation in full, still without its messages',
    description:
      'Adds per-category redaction counts, the semantic-flag count, and each side’s last-read and cleared-at marks. `hiddenAt` means that party cleared their own copy; the rows are untouched and the other side still reads every one of them.',
  })
  @ApiResponse({ status: 200, description: 'Conversation detail' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.detail(id);
  }

  // MANAGER, overriding the class — the handler wins in `RolesGuard`. Closing
  // silences two real people for good, and a MODERATOR cannot read the thread
  // they would be closing: a control that acts on evidence you are not allowed
  // to look at is not a moderation control.
  //
  // Lateral roles cannot reach this even if they are later granted the prefix:
  // `lateralRoleCanAccess` takes the HTTP method, and `read` is GET only.
  @Post(':id/close')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Lock a conversation',
    description:
      'Neither party may write in it again. Nothing is deleted — both keep every message, and each side’s app shows the thread as closed instead of a composer. Idempotent: closing a closed conversation does not move the timestamp.',
  })
  @ApiResponse({ status: 200, description: 'Conversation detail, now closed' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const conversation = await this.conversations.close(id);
    await this.logService.create({
      action: 'CONVERSATION_CLOSED',
      entityType: 'ProfileConversation',
      entityId: id,
      userId: req.user.userId,
      // Who was silenced, never what they said.
      metadata: {
        workerId: conversation.worker.id,
        employerId: conversation.employer.id,
      },
      ...extractRequestMeta(req),
    });
    return conversation;
  }

  // Ships with close, not after it: this is the only writer of `closed_at`, so
  // without a way back a misclick is permanent.
  @Post(':id/reopen')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Unlock a conversation',
    description:
      'Both parties may write again. Idempotent, like close.',
  })
  @ApiResponse({ status: 200, description: 'Conversation detail, now open' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const conversation = await this.conversations.reopen(id);
    await this.logService.create({
      action: 'CONVERSATION_REOPENED',
      entityType: 'ProfileConversation',
      entityId: id,
      userId: req.user.userId,
      metadata: {
        workerId: conversation.worker.id,
        employerId: conversation.employer.id,
      },
      ...extractRequestMeta(req),
    });
    return conversation;
  }
}
