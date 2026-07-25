import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Delete,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiConsumes,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { FileService } from '../file/file.service';
import { ChatService, type ChatAttachment } from './chat.service';
import { ChatGateway } from './chat.gateway';
import {
  CreateDirectDto,
  CreateGroupDto,
  SendMessageDto,
  EditMessageDto,
} from './dto/chat.dto';

@ApiTags('Admin – Chat')
@Controller('admin/chat')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly gateway: ChatGateway,
    private readonly fileService: FileService,
  ) {}

  private userId(req: AdminAuthenticatedRequest): string {
    return req.user.userId;
  }

  @Get('users')
  @ApiOperation({ summary: 'List team members available to chat with' })
  listUsers(@Req() req: AdminAuthenticatedRequest) {
    return this.chatService.listTeamUsers(this.userId(req));
  }

  @Get('conversations')
  @ApiOperation({
    summary: 'List my conversations (with unread + last message)',
  })
  listConversations(@Req() req: AdminAuthenticatedRequest) {
    return this.chatService.listConversations(this.userId(req));
  }

  @Post('conversations/direct')
  @ApiOperation({ summary: 'Get or create a 1:1 conversation' })
  async createDirect(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: CreateDirectDto,
  ) {
    const convo = await this.chatService.getOrCreateDirect(
      this.userId(req),
      dto.userId,
    );
    this.gateway.joinParticipants(convo);
    return convo;
  }

  @Post('conversations/group')
  @ApiOperation({ summary: 'Create a group conversation' })
  async createGroup(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: CreateGroupDto,
  ) {
    const convo = await this.chatService.createGroup(
      this.userId(req),
      dto.name,
      dto.memberIds,
    );
    this.gateway.joinParticipants(convo);
    return convo;
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: 'Paginated message history (cursor-based)' })
  getMessages(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chatService.getMessages(
      this.userId(req),
      id,
      cursor,
      limit ? Math.min(Number(limit) || 30, 100) : undefined,
    );
  }

  @Post('conversations/:id/messages')
  @ApiOperation({
    summary: 'Send a message (durable path; also emits realtime)',
  })
  async sendMessage(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    const result = await this.chatService.sendMessage(this.userId(req), id, {
      body: dto.body,
      attachments: dto.attachments,
    });
    this.gateway.emitNewMessage(result.message, result.recipientIds, {
      id: result.conversation.id,
      name: result.conversation.name,
    });
    return result.message;
  }

  @Post('conversations/:id/read')
  @ApiOperation({ summary: 'Mark a conversation as read' })
  async markRead(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.chatService.markRead(this.userId(req), id);
    return { success: true };
  }

  @Patch('messages/:id')
  @ApiOperation({ summary: 'Edit my message' })
  async editMessage(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: EditMessageDto,
  ) {
    const message = await this.chatService.editMessage(
      this.userId(req),
      id,
      dto.body,
    );
    this.gateway.emitEditedMessage(message);
    return message;
  }

  @Delete('messages/:id')
  @ApiOperation({ summary: 'Delete my message' })
  async deleteMessage(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const { conversationId } = await this.chatService.deleteMessage(
      this.userId(req),
      id,
    );
    this.gateway.emitDeletedMessage(conversationId, id);
    return { success: true };
  }

  @Post('attachments')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a chat attachment (image/file)' })
  async uploadAttachment(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<ChatAttachment> {
    if (!file) throw new BadRequestException('No file provided');
    const uploaded = await this.fileService.uploadToStorage(file, {
      folder: 'chat',
      access: 'public',
    });
    return {
      url: uploaded.url,
      key: uploaded.key,
      name: uploaded.originalFilename,
      mime: uploaded.mimeType,
      size: uploaded.size ?? file.size,
    };
  }
}
