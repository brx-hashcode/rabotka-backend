import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { sendWelcomeEmail } from './templates';
import { MailService } from './mail.service';

@ApiTags('Mail')
@Controller('mail')
export class MailController {
  constructor(private readonly mailService: MailService) {}

  @Get('send-welcome')
  @ApiOperation({
    summary: 'Send welcome email',
    description:
      'Queues a welcome email (HTML) to blondeau.nbif@mail.ru (for testing).',
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
    const email: string = 'blondeau.nbif@mail.ru';
    const name = 'Blondeau';

    const { jobId } = await this.mailService.sendMail({
      to: email,
      subject: 'Welcome to Rabotka',
      html: sendWelcomeEmail(name),
    });
    return { jobId, message: 'Welcome email queued', email };
  }
}
