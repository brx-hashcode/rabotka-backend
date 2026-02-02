import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MailService } from './mail.service.js';

@ApiTags('Mail')
@Controller('mail')
export class MailController {
  constructor(private readonly mailService: MailService) {}

  @Get('send-welcome')
  @ApiOperation({
    summary: 'Send welcome email',
    description:
      'Queues a welcome template email to wodod93616@aixind.com (for testing).',
  })
  @ApiResponse({
    status: 200,
    description: 'Email queued',
    schema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, message: { type: 'string' } },
    },
  })
  async sendWelcome() {
    const { jobId } = await this.mailService.sendMail({
      to: 'wodod93616@aixind.com',
      subject: 'Welcome',
      template: 'welcome',
      context: { name: 'Wodod' },
    });
    return { jobId, message: 'Welcome email queued' };
  }
}
