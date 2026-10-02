import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { KycDocumentCategory, UserRole } from '@prisma/client';
import type { Response } from 'express';
import { ALLOWED_IMAGE_MIME_TYPES } from '../../common/constants/image-upload';
import { imageMulterOptions } from '../../common/utils/image-upload.util';
import { extractRequestMeta } from '../../common/utils/request-meta.util';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import type {
  AdminAuthenticatedRequest,
  AuthenticatedRequest,
} from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { LogService } from '../log/log.service';
import { AdminAgentService, AgentStatusAction } from './admin-agent.service';
import { AgentWalletService } from './agent-wallet.service';
import {
  AgentStatsService,
  TIMESERIES_RANGES,
  type TimeseriesRange,
} from './agent-stats.service';
import {
  AdminListAgentsDto,
  AgentStatusReasonDto,
  CreateAgentDto,
  ReplaceAgentAvatarDto,
  ReplaceAgentKycDocumentDto,
  UpdateAgentDto,
} from './dto/admin-agent.dto';

const KYC_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const AVATAR_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const STATUS_LOG_ACTIONS: Record<AgentStatusAction, string> = {
  suspend: 'AGENT_SUSPENDED',
  reactivate: 'AGENT_REACTIVATED',
  revoke: 'AGENT_REVOKED',
};
const KYC_MIME_TYPES = new Set<string>([
  ...ALLOWED_IMAGE_MIME_TYPES,
  'application/pdf',
]);

/**
 * Field agents, from the back office. The only way an agent comes to exist:
 * there is no signup.
 *
 * MANAGER to create, edit and change status; MODERATOR to read — the same
 * split as profiles. Every write and every identity-document view is logged.
 */
@ApiTags('Admin – Agents')
@Controller('admin/agents')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminAgentController {
  constructor(
    private readonly agents: AdminAgentService,
    private readonly logService: LogService,
    private readonly wallet: AgentWalletService,
    private readonly stats: AgentStatsService,
  ) {}

  @Post('uploads/kyc')
  @Roles(UserRole.MANAGER)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: KYC_UPLOAD_MAX_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!KYC_MIME_TYPES.has(file.mimetype)) {
          cb(
            new BadRequestException('Formats acceptés : JPG, PNG, WEBP, PDF'),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload one agent identity document (private bucket)',
    description:
      'Returns only the storage key, to send back in POST admin/agents. No url is issued.',
  })
  @ApiResponse({ status: 201, description: '{ key }' })
  uploadKyc(@UploadedFile() file: Express.Multer.File) {
    return this.agents.uploadKycFile(file);
  }

  @Post('uploads/avatar')
  @Roles(UserRole.MANAGER)
  @UseInterceptors(
    FileInterceptor('avatar', imageMulterOptions(AVATAR_UPLOAD_MAX_BYTES)),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload an agent avatar (public bucket)' })
  @ApiResponse({ status: 201, description: '{ key, url }' })
  uploadAvatar(@UploadedFile() avatar: Express.Multer.File) {
    return this.agents.uploadAvatar(avatar);
  }

  @Post()
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Create an agent',
    description:
      'Requires the full identity-document set for the document type. Sends a welcome email.',
  })
  @ApiResponse({ status: 201, description: 'The created agent' })
  @ApiResponse({
    status: 400,
    description: 'Invalid field or missing document',
  })
  @ApiResponse({ status: 409, description: 'Email, phone or ID already used' })
  async create(
    @Body() dto: CreateAgentDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const agent = await this.agents.create(dto, req.user.userId);
    await this.log(req, 'AGENT_CREATED', agent.id, {
      email: agent.email,
      zones: agent.zones,
    });
    return agent;
  }

  /**
   * The headline figures above the list. Declared before `:id`, which would
   * otherwise take "stats" for an id. Money is left out for a MODERATOR, the
   * same line as the per-agent wallet.
   */
  @Get('stats')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Agent headline stats' })
  getStats(@Req() req: AuthenticatedRequest) {
    // Set by AdminAuthGuard, which has already read the account.
    const role = req.adminAccount?.role;
    return this.stats.getStats(
      role !== undefined && role !== UserRole.MODERATOR,
    );
  }

  /** The same figures, day by day, for the chart under the cards. */
  @Get('stats/timeseries')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Agent metrics per day (7, 30, 90 or 180 days)' })
  getTimeseries(
    @Req() req: AuthenticatedRequest,
    @Query('days', new DefaultValuePipe(90), ParseIntPipe) days: number,
  ) {
    if (!(TIMESERIES_RANGES as readonly number[]).includes(days)) {
      throw new BadRequestException(
        `days must be one of ${TIMESERIES_RANGES.join(', ')}`,
      );
    }
    const role = req.adminAccount?.role;
    return this.stats.getTimeseries(
      days as TimeseriesRange,
      role !== undefined && role !== UserRole.MODERATOR,
    );
  }

  /** The cities agents cover, for the list's Zone filter. */
  @Get('zones')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Cities covered by agents, with agent counts' })
  listZones() {
    return this.agents.listZones();
  }

  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'List agents' })
  list(@Query() dto: AdminListAgentsDto) {
    return this.agents.list(dto);
  }

  @Get(':id')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Agent detail, with document metadata' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.agents.getDetail(id);
  }

  /**
   * The agent's audit trail: creation, edits, status changes, document
   * replacements and views, and their own sign-ins — everything logged under
   * `entityType: 'Agent'`. Same shape as the profile timeline.
   */
  @Get(':id/logs')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Agent activity timeline (latest 50)' })
  getLogs(@Param('id', ParseUUIDPipe) id: string) {
    return this.logService.getByEntity('Agent', id);
  }

  /**
   * Balance and ledger movements. MANAGER, like referral payouts: it is money,
   * which a moderator has no business in. Computed from the append-only
   * ledger on every read.
   */
  @Get(':id/wallet')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Agent balance and ledger movements' })
  async getWallet(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    await this.agents.getDetail(id); // 404 for an unknown agent
    const [balance, entries] = await Promise.all([
      this.wallet.getBalance(id),
      this.wallet.listEntries(
        id,
        Math.max(page, 1),
        Math.min(Math.max(limit, 1), 100),
      ),
    ]);
    return { balance, entries };
  }

  @Patch(':id')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Edit name, email, phone or zones' })
  @ApiResponse({ status: 409, description: 'Email or phone already used' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAgentDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const agent = await this.agents.update(id, dto);
    await this.log(req, 'AGENT_UPDATED', id, {
      fields: Object.keys(dto),
    });
    return agent;
  }

  @Post(':id/suspend')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Suspend an active agent (reason required)' })
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AgentStatusReasonDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    return this.changeStatus(id, 'suspend', dto.reason, req);
  }

  @Post(':id/reactivate')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Reactivate a suspended agent' })
  reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    return this.changeStatus(id, 'reactivate', undefined, req);
  }

  @Post(':id/revoke')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'End the agency relationship (terminal, reason required)',
  })
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AgentStatusReasonDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    return this.changeStatus(id, 'revoke', dto.reason, req);
  }

  @Put(':id/avatar')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Replace the avatar with an uploaded one' })
  async replaceAvatar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceAgentAvatarDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const agent = await this.agents.replaceAvatar(id, dto.avatarKey);
    await this.log(req, 'AGENT_AVATAR_REPLACED', id);
    return agent;
  }

  @Put(':id/kyc-documents/:category')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Replace one identity document' })
  async replaceKycDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('category', new ParseEnumPipe(KycDocumentCategory))
    category: KycDocumentCategory,
    @Body() dto: ReplaceAgentKycDocumentDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const agent = await this.agents.replaceKycDocument(
      id,
      category,
      dto.key,
      req.user.userId,
    );
    await this.log(req, 'AGENT_KYC_DOCUMENT_REPLACED', id, { category });
    return agent;
  }

  /**
   * The bytes of one identity document, behind the admin session — the same
   * contract as the profile route (`admin/profiles/:id/kyc-documents/…/raw`):
   * no url ever exists, and nothing is cached. Every view is logged.
   */
  @Get(':id/kyc-documents/:documentId/raw')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Stream an agent identity document' })
  @ApiResponse({ status: 200, description: 'The file bytes' })
  @ApiResponse({ status: 404, description: 'No such document on this agent' })
  async streamKycDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Req() req: AdminAuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.agents.streamKycDocument(id, documentId);
    // One entry per admin per agent per hour: the Identity tab's thumbnails
    // load through this route too, and logging each request would bury the
    // timeline under page renders. "Who looked at this ID, and when" stays
    // answerable to the hour.
    if (await this.agents.isNewKycViewWindow(id, req.user.userId)) {
      await this.log(req, 'AGENT_KYC_VIEWED', id, { documentId });
    }

    res.setHeader(
      'Content-Type',
      file.contentType || 'application/octet-stream',
    );
    if (file.contentLength !== undefined) {
      res.setHeader('Content-Length', String(file.contentLength));
    }
    res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    file.body.pipe(res);
  }

  private async changeStatus(
    id: string,
    action: AgentStatusAction,
    reason: string | undefined,
    req: AdminAuthenticatedRequest,
  ) {
    const agent = await this.agents.setStatus(id, action, reason);
    await this.log(req, STATUS_LOG_ACTIONS[action], id, {
      status: agent.status,
      reason: reason ?? null,
    });
    return agent;
  }

  private log(
    req: AdminAuthenticatedRequest,
    action: string,
    agentId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    return this.logService.create({
      action,
      entityType: 'Agent',
      entityId: agentId,
      userId: req.user.userId,
      metadata: { agentId, ...metadata },
      ...extractRequestMeta(req),
    });
  }
}
