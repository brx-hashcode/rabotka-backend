import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { BulkMessageDto, MessageTemplateDto } from './dto/message-template.dto';
import { BusinessMessagesService } from './business-messages.service';

/**
 * « Modèles de messages » (read by every member, written by those who hire:
 * team-access), and « Envoyer un message » to several candidates of an offer.
 */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class BusinessMessagesController {
  constructor(private readonly messages: BusinessMessagesService) {}

  @Get('message-templates')
  @ApiOperation({
    summary: "The business's message templates, and ready-made ones",
    description:
      '`suggested` holds ready-made templates for the kinds it has not written yet.',
  })
  list(@Req() req: ProfileAuthenticatedRequest) {
    return this.messages.list(req.user.profileId);
  }

  @Post('message-templates')
  @ApiOperation({ summary: 'Add a message template (30 at most)' })
  create(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() dto: MessageTemplateDto,
  ) {
    return this.messages.create(
      { profileId: req.user.profileId, memberId: req.user.memberId },
      dto,
    );
  }

  @Patch('message-templates/:id')
  @ApiOperation({ summary: 'Edit a message template' })
  update(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MessageTemplateDto,
  ) {
    return this.messages.update(req.user.profileId, id, dto);
  }

  @Delete('message-templates/:id')
  @ApiOperation({ summary: 'Delete a message template' })
  remove(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.messages.remove(req.user.profileId, id);
  }

  @Post('offers/:offerId/messages')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Send one message to several candidates of an offer',
    description:
      '{prenom}, {poste} and {entreprise} are filled in for each. Rabotka candidates get it in their conversation (no contact details allowed); careers-page ones by e-mail.',
  })
  send(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Body() dto: BulkMessageDto,
  ) {
    return this.messages.send(
      { profileId: req.user.profileId, memberId: req.user.memberId },
      offerId,
      dto,
    );
  }
}
