import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConversationService } from './conversation.service';

@ApiTags('Conversation')
@Controller('conversation')
export class ConversationController {
  constructor(private readonly conversationService: ConversationService) {}
}
