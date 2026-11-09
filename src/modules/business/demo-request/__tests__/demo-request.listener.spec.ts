import type { ConfigService } from '@nestjs/config';
import { AdminNotificationEvent } from '../../../../common/events/admin-notification.events';
import type { PrismaService } from '../../../../common/services/prisma/prisma.service';
import type { LayoutService } from '../../../mail/layout.service';
import type { MailService } from '../../../mail/mail.service';
import { DemoRequestListener } from '../demo-request.listener';

const payload = {
  event: AdminNotificationEvent.DEMO_REQUEST_CREATED,
  title: 'Demande de démo',
  message: 'Boulangerie du Plateau',
  entityType: 'demo-request' as const,
  entityId: 'demo-1',
  timestamp: new Date().toISOString(),
};

function setup(sendMail = jest.fn().mockResolvedValue(undefined)) {
  const prisma = {
    demoRequest: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'demo-1',
        first_name: 'Awa',
        last_name: 'Mboko',
        email: 'awa@example.com',
        phone: '+242061234567',
        company: 'Boulangerie du Plateau',
        job_title: 'Gérante',
        country_code: 'CG',
        company_size: '6-20',
        interests: ['analyse-cv'],
        message: null,
      }),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([
        { email: 'a@rabotka.work', first_name: 'Alice' },
        { email: 'b@rabotka.work', first_name: 'Bruno' },
      ]),
    },
  };
  const layout = { wrap: jest.fn((html: string) => Promise.resolve(html)) };
  const config = {
    get: jest.fn().mockReturnValue('https://admin.rabotka.work/'),
  };
  const listener = new DemoRequestListener(
    prisma as unknown as PrismaService,
    { sendMail } as unknown as MailService,
    layout as unknown as LayoutService,
    config as unknown as ConfigService,
  );
  return { listener, sendMail };
}

describe('DemoRequestListener', () => {
  it('confirms to the company and e-mails each staff member a link', async () => {
    const { listener, sendMail } = setup();

    await listener.onCreated(payload);

    const to = sendMail.mock.calls.map((c) => c[0].to);
    expect(to).toEqual(['awa@example.com', 'a@rabotka.work', 'b@rabotka.work']);
    expect(sendMail.mock.calls[1][0].html).toContain(
      'https://admin.rabotka.work/demo-requests/demo-1',
    );
    expect(sendMail.mock.calls[1][0].html).toContain('Analyse de CV');
  });

  it('never throws when the mail queue fails', async () => {
    const { listener } = setup(jest.fn().mockRejectedValue(new Error('down')));

    await expect(listener.onCreated(payload)).resolves.toBeUndefined();
  });
});
