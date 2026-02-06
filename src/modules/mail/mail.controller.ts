import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { sendWelcomeEmail } from './templates/index.js';
import { MailService } from './mail.service.js';

@ApiTags('Mail')
@Controller('mail')
export class MailController {
  constructor(private readonly mailService: MailService) {}

  @Get('send-welcome')
  @ApiOperation({
    summary: 'Send welcome email',
    description:
      'Queues a welcome email (HTML) to fariol@akieni.tech (for testing).',
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
    const email: string = 'fariol@akieni.tech';
    const name = 'Fariol';

    const { jobId } = await this.mailService.sendMail({
      to: email,
      subject: 'Welcome to Rabotka',
      html: sendWelcomeEmail(name),
    });
    return { jobId, message: 'Welcome email queued', email };
  }
}
