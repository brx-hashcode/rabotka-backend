import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CandidateOpinionVerdict } from '@prisma/client';
import { IsEnum, IsString, MaxLength } from 'class-validator';

import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { TeamService } from '../team/team.service';
import {
  CandidateNotesService,
  MAX_NOTE,
  type ApplicationKind,
} from './candidate-notes.service';

class NoteDto {
  @IsString()
  @MaxLength(MAX_NOTE)
  body!: string;
}

class OpinionDto {
  @IsEnum(CandidateOpinionVerdict)
  verdict!: CandidateOpinionVerdict;
}

/** `rabotka` or `external`, checked on the one param (the global pipe forbids unknown keys). */
const KIND = new ParseEnumPipe({
  rabotka: 'rabotka',
  external: 'external',
} as const);

/**
 * The team's private side of a candidate: notes, opinions, timeline. Open to
 * every member, Évaluateurs included (team-access.ts lists these routes).
 */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class CandidateNotesController {
  constructor(
    private readonly notes: CandidateNotesService,
    private readonly team: TeamService,
  ) {}

  private actor(req: ProfileAuthenticatedRequest) {
    return this.team.actor(req.user.profileId, req.user.memberId);
  }

  @Get('applications/:kind/:id/notes')
  @ApiOperation({ summary: "The team's notes on an application" })
  async list(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('kind', KIND) kind: ApplicationKind,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notes.notes(await this.actor(req), kind, id);
  }

  @Post('applications/:kind/:id/notes')
  @ApiOperation({ summary: 'Add a note (never shown to the candidate)' })
  async add(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('kind', KIND) kind: ApplicationKind,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NoteDto,
  ) {
    return this.notes.addNote(await this.actor(req), kind, id, dto.body);
  }

  @Patch('applications/:kind/:id/notes/:noteId')
  @ApiOperation({ summary: 'Edit one of my notes' })
  async edit(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('kind', KIND) kind: ApplicationKind,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() dto: NoteDto,
  ) {
    return this.notes.editNote(
      await this.actor(req),
      kind,
      id,
      noteId,
      dto.body,
    );
  }

  @Delete('applications/:kind/:id/notes/:noteId')
  @ApiOperation({ summary: 'Delete one of my notes' })
  async remove(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('kind', KIND) kind: ApplicationKind,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
  ) {
    return this.notes.deleteNote(await this.actor(req), kind, id, noteId);
  }

  @Get('applications/:kind/:id/opinion')
  @ApiOperation({ summary: "Each member's opinion, and mine" })
  async opinions(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('kind', KIND) kind: ApplicationKind,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notes.opinions(await this.actor(req), kind, id);
  }

  @Put('applications/:kind/:id/opinion')
  @ApiOperation({
    summary: 'Give or change my opinion (Oui / Peut-être / Non)',
  })
  async setOpinion(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('kind', KIND) kind: ApplicationKind,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OpinionDto,
  ) {
    return this.notes.setOpinion(await this.actor(req), kind, id, dto.verdict);
  }

  @Delete('applications/:kind/:id/opinion')
  @ApiOperation({ summary: 'Withdraw my opinion' })
  async clearOpinion(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('kind', KIND) kind: ApplicationKind,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notes.clearOpinion(await this.actor(req), kind, id);
  }

  @Get('applications/:kind/:id/timeline')
  @ApiOperation({ summary: 'What happened to the application, oldest first' })
  async timeline(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('kind', KIND) kind: ApplicationKind,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notes.timeline(await this.actor(req), kind, id);
  }

  @Get('offers/:offerId/opinions')
  @ApiOperation({ summary: "The team's opinions on an offer's applications" })
  async offerOpinions(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ) {
    return this.notes.offerOpinions(await this.actor(req), offerId);
  }
}
