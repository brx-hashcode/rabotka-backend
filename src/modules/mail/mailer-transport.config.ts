import type { ConfigService } from '@nestjs/config';

export function getMailerTransportConfig(config: ConfigService) {
  const host = config.get<string>('SMTP_HOST');
  const port = config.get<number>('SMTP_PORT');
  const secure = config.get<string>('SMTP_SECURE') === 'true';
  const user = config.get<string>('SMTP_USER');
  const pass = config.get<string>('SMTP_PASSWORD');
  const fromAddress = config.get<string>('SMTP_FROM_ADDRESS');
  const fromName = config.get<string>('SMTP_FROM_NAME');

  const from = fromName ? `${fromName} <${fromAddress}>` : fromAddress;

  return {
    transport: {
      host,
      port,
      secure,
      ...(user && pass ? { auth: { user, pass } } : {}),
    },
    defaults: {
      from,
    },
  };
}
