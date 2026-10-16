import { DEFAULT_SYSTEM_CONFIGS } from '../../system-config/system-config.constants';
import {
  TEMPLATE_NOTIFICATION_GROUP,
  WHATSAPP_NOTIFICATION_GROUPS,
  whatsAppNotificationKey,
  type WhatsAppNotificationGroup,
} from '../whatsapp-notification-groups';

const groups = Object.keys(
  WHATSAPP_NOTIFICATION_GROUPS,
) as WhatsAppNotificationGroup[];

describe('WhatsApp notification groups', () => {
  it('keeps WhatsApp on only for offers, applications, acceptances and unlocks', () => {
    expect(
      groups.filter((g) => WHATSAPP_NOTIFICATION_GROUPS[g]).sort(),
    ).toEqual([
      'application_accepted',
      'contact_unlocked',
      'job_recommendations',
      'new_application',
    ]);
  });

  it.each(groups)('seeds whatsapp.notify.%s with its default', (group) => {
    const seeded = DEFAULT_SYSTEM_CONFIGS.find(
      (c) => c.key === whatsAppNotificationKey(group),
    );
    expect(seeded?.value).toBe(String(WHATSAPP_NOTIFICATION_GROUPS[group]));
  });

  it('maps every template onto a known group', () => {
    for (const group of Object.values(TEMPLATE_NOTIFICATION_GROUP)) {
      expect(groups).toContain(group);
    }
  });

  it('never gates the messages people need before they are in the app', () => {
    for (const key of [
      'otp',
      'kyc',
      'accountActivatedWorker',
      'adminMessage',
    ]) {
      expect(
        TEMPLATE_NOTIFICATION_GROUP[
          key as keyof typeof TEMPLATE_NOTIFICATION_GROUP
        ],
      ).toBeUndefined();
    }
  });
});
