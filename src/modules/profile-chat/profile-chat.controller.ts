import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { ProfileChatService } from './profile-chat.service';
import {
  ListConversationsDto,
  ListMessagesDto,
  ReportRedactionDto,
  SendMessageDto,
} from './dto/profile-chat.dto';

/**
 * Profile-to-profile messaging, over REST.
 *
 * SENDING IS A REQUEST, NOT AN EMIT, and that is the reason this is a
 * controller rather than a gateway. Moderation has to hand the author a verdict
 * — which fragments of their own message stayed behind — and that is a
 * request/response shape. Everything that writes a row lives here — sending,
 * reading, deleting. The socket's only inbound handler is `typing`, which
 * stores nothing; see `profile-chat.gateway.ts` for the conditions anything
 * else would have to meet to join it.
 *
 * It also keeps the global `ValidationPipe` in play. It does not run on
 * gateways: `chat.gateway.ts` accepts a message body over the socket that no
 * DTO ever validates, because `SendMessageDto`'s bounds only apply on the REST
 * path. Not repeating that is worth a round trip.
 */
@ApiTags('Profile Chat')
@ApiBearerAuth()
@ApiCookieAuth()
@Controller('profile/discussions')
export class ProfileChatController {
  constructor(private readonly chat: ProfileChatService) {}

  @Get()
  @UseGuards(ProfileAuthGuard)
  @ApiOperation({ summary: 'Mes discussions' })
  async list(
    @Req() req: ProfileAuthenticatedRequest,
    @Query() query: ListConversationsDto,
  ) {
    return this.chat.listConversations(
      req.user.profileId,
      query.page,
      query.limit,
    );
  }

  /**
   * Opens (or finds) the conversation attached to an application.
   *
   * Idempotent by design — the unique index on `application_id` makes a second
   * call return the first result — so the client may call it on every entry
   * into the screen without guarding.
   */
  @Post('applications/:applicationId')
  @UseGuards(ProfileAuthGuard, ActiveProfileGuard)
  @ApiOperation({ summary: 'Ouvrir la discussion d’une candidature' })
  async open(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
  ) {
    const conversation = await this.chat.openForApplication(
      applicationId,
      req.user.profileId,
    );
    return { conversation: { id: conversation.id } };
  }

  /**
   * Opens a conversation with a profile directly, with no application.
   *
   * Throttled harder than sending: this is the one endpoint that can reach
   * somebody who never asked to be reached, and the per-day cap in the service
   * is the ceiling while this is the rate.
   */
  @Post('profiles/:profileId')
  @UseGuards(ProfileAuthGuard, ActiveProfileGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Ouvrir une discussion avec un profil' })
  async openWith(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('profileId', ParseUUIDPipe) profileId: string,
  ) {
    const conversation = await this.chat.openWithProfile(
      profileId,
      req.user.profileId,
    );
    return { conversation: { id: conversation.id } };
  }

  /**
   * One conversation's header data — counterpart, job, presence — including
   * for a thread nobody has written in yet, which the list leaves out.
   */
  @Get(':id')
  @UseGuards(ProfileAuthGuard)
  @ApiOperation({ summary: 'Une discussion' })
  async one(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return {
      conversation: await this.chat.getConversation(id, req.user.profileId),
    };
  }

  @Get(':id/messages')
  @UseGuards(ProfileAuthGuard)
  @ApiOperation({ summary: 'Messages d’une discussion' })
  async messages(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListMessagesDto,
  ) {
    return this.chat.listMessages(
      id,
      req.user.profileId,
      query.page,
      query.limit,
    );
  }

  /**
   * The only moderated endpoint, and the only one that is rate limited per
   * route.
   *
   * 20 a minute: high enough that nobody typing in good faith ever meets it,
   * low enough that the thread cannot be turned into a firehose. It matters
   * more than it looks — once the semantic pass lands, every message that
   * clears the deterministic one may cost a model call, so this ceiling is also
   * a ceiling on the bill.
   *
   * `ActiveProfileGuard` is here and not on the read routes: someone suspended
   * mid-conversation should still be able to read what was said to them.
   */
  @Post(':id/messages')
  @UseGuards(ProfileAuthGuard, ActiveProfileGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Envoyer un message' })
  async send(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
  ) {
    const message = await this.chat.sendMessage(
      id,
      req.user.profileId,
      dto.body,
    );
    return { message };
  }

  /**
   * "Supprimer la discussion". For this side only — see `hideConversation`.
   *
   * DELETE for the verb the client means, although nothing is deleted: the
   * rows stay as evidence and the other party keeps their history.
   */
  @Delete(':id')
  @UseGuards(ProfileAuthGuard)
  @ApiOperation({ summary: 'Supprimer la discussion (pour moi)' })
  async hide(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.chat.hideConversation(id, req.user.profileId);
    return { ok: true };
  }

  @Post(':id/read')
  @UseGuards(ProfileAuthGuard)
  @ApiOperation({ summary: 'Marquer la discussion comme lue' })
  async read(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const count = await this.chat.markRead(id, req.user.profileId);
    return { ok: true, count };
  }

  /**
   * Contest a redaction.
   *
   * Throttled harder than sending. A report costs a human's attention rather
   * than a database row, and the corpus is only worth tuning against if it is
   * not padded.
   */
  @Post('messages/:messageId/report')
  @UseGuards(ProfileAuthGuard, ActiveProfileGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Signaler un masquage abusif' })
  async report(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: ReportRedactionDto,
  ) {
    await this.chat.reportRedaction(messageId, req.user.profileId, dto.note);
    return { ok: true };
  }

  /**
   * Take one of your own messages back.
   *
   * Both parties then see a tombstone rather than the message — nothing
   * vanishes from the thread, and nothing is erased from the row moderation
   * reads. Throttled like sending: the ceiling stops a script walking a
   * thread, it does not ration ordinary use.
   *
   * Two segments, so it never collides with `DELETE :id` above — that one hides
   * a whole conversation and means something entirely different.
   */
  @Delete('messages/:messageId')
  @UseGuards(ProfileAuthGuard, ActiveProfileGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Supprimer un message envoyé' })
  async deleteMessage(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ) {
    await this.chat.deleteMessage(messageId, req.user.profileId);
    return { ok: true };
  }
}
