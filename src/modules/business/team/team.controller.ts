import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { INVITED_ROLES, TeamService, type InvitedRole } from './team.service';

const ROLE_MESSAGE = {
  message: 'Rôle : RECRUITER (recruteur) ou REVIEWER (évaluateur).',
};

class InviteMemberDto {
  @IsEmail({}, { message: 'Adresse e-mail invalide' })
  @MaxLength(200)
  email!: string;

  @IsString()
  @MaxLength(120)
  name!: string;

  /** The holder is the one administrator: members are recruiters or reviewers. */
  @IsIn(INVITED_ROLES, ROLE_MESSAGE)
  role!: InvitedRole;
}

class MemberRoleDto {
  @IsIn(INVITED_ROLES, ROLE_MESSAGE)
  role!: InvitedRole;
}

class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  emailsOn?: boolean;
}

class ActivityQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsUUID()
  memberId?: string;
}

/**
 * « Équipe »: who works in the business space, their roles, who did what.
 * Managing the team is for administrators (team-access.ts refuses the others
 * before this runs; the service checks again).
 */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class TeamController {
  constructor(private readonly team: TeamService) {}

  private actor(req: ProfileAuthenticatedRequest) {
    return this.team.actor(req.user.profileId, req.user.memberId);
  }

  @Get('member')
  @ApiOperation({ summary: 'Who is signed in: name, role, holder or member' })
  async me(@Req() req: ProfileAuthenticatedRequest) {
    return this.team.me(await this.actor(req));
  }

  @Patch('member')
  @ApiOperation({ summary: 'My name and my e-mail switch' })
  async updateMe(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() dto: UpdateMeDto,
  ) {
    return this.team.updateMe(await this.actor(req), dto);
  }

  @Get('team')
  @ApiOperation({ summary: 'The members, and seats used against the plan' })
  async list(@Req() req: ProfileAuthenticatedRequest) {
    return this.team.list(await this.actor(req));
  }

  @Post('team')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Invite someone by e-mail, with a role' })
  async invite(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() dto: InviteMemberDto,
  ) {
    return this.team.invite(await this.actor(req), dto);
  }

  @Post('team/:id/resend')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send the invitation again' })
  async resend(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.team.resend(await this.actor(req), id);
  }

  @Patch('team/:id')
  @ApiOperation({ summary: "Change a member's role" })
  async setRole(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MemberRoleDto,
  ) {
    return this.team.setRole(await this.actor(req), id, dto.role);
  }

  @Delete('team/:id')
  @ApiOperation({ summary: 'Remove a member: its sessions stop at once' })
  async remove(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.team.remove(await this.actor(req), id);
  }

  @Get('activity')
  @ApiOperation({ summary: 'Who did what, newest first' })
  async activity(
    @Req() req: ProfileAuthenticatedRequest,
    @Query() query: ActivityQueryDto,
  ) {
    return this.team.activity(await this.actor(req), query);
  }
}
