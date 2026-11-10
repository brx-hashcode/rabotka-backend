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
  };
  const layout = { wrap: jest.fn((html: string) => Promise.resolve(html)) };
  const listener = new DemoRequestListener(
    prisma as unknown as PrismaService,
    { sendMail } as unknown as MailService,
    layout as unknown as LayoutService,
  );
  return { listener, sendMail };
}

describe('DemoRequestListener', () => {
  it('sends one e-mail, the confirmation to the requester, never to staff', async () => {
    const { listener, sendMail } = setup();

    await listener.onCreated(payload);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('awa@example.com');
    expect(mail.subject).toBe(
      'Votre demande de démo Rabotka Business est bien reçue',
    );
    expect(mail.html).toContain('Boulangerie du Plateau');
    expect(mail.html).toContain('Analyse de CV');
    expect(mail.html).toContain('6-20 salariés');
    expect(mail.html).toContain('+242 06 123 45 67');
  });

  it('never throws when the mail queue fails', async () => {
    const { listener } = setup(jest.fn().mockRejectedValue(new Error('down')));

    await expect(listener.onCreated(payload)).resolves.toBeUndefined();
  });
});
