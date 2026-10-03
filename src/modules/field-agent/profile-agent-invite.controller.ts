import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { KycVerifiedGuard } from '../auth/guards/kyc-verified.guard';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { AgentInviteService } from './agent-invite.service';

/**
 * Where a worker answers an agent's invitation, signed in as themselves.
 * The token is the one in the link the agent sent.
 */
@ApiTags('Profile – Agent invitations')
@Controller('profile/agent-invites')
@UseGuards(ProfileAuthGuard)
export class ProfileAgentInviteController {
  constructor(private readonly invites: AgentInviteService) {}

  @Get(':token')
  @ApiOperation({ summary: 'The job an agent invited me to' })
  @ApiResponse({ status: 404, description: 'Unknown, or not mine' })
  get(@Req() req: ProfileAuthenticatedRequest, @Param('token') token: string) {
    return this.invites.get(req.user.profileId, token);
  }

  @Post(':token/accept')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ActiveProfileGuard, KycVerifiedGuard)
  @ApiOperation({
    summary: 'Apply to the job through this invitation',
    description:
      'Same checks as applying directly; the application records the agent.',
  })
  @ApiResponse({ status: 410, description: 'Expired or already answered' })
  accept(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('token') token: string,
  ) {
    return this.invites.accept(req.user.profileId, token);
  }

  @Post(':token/decline')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ActiveProfileGuard)
  @ApiOperation({ summary: 'Turn the invitation down' })
  @ApiResponse({ status: 410, description: 'Expired or already answered' })
  decline(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('token') token: string,
  ) {
    return this.invites.decline(req.user.profileId, token);
  }
}
