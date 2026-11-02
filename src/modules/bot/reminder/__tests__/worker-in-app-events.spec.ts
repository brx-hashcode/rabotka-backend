import {
  notifyProfile,
  PROFILE_NOTIFICATION_EVENT,
} from '../../../profile-notification/profile-notification.events';
import { workerInAppEvents } from '../worker-in-app-events';

describe('workerInAppEvents', () => {
  it('carries a notification from the scan to the bell', () => {
    const handleEvent = jest.fn().mockResolvedValue(undefined);
    const payload = {
      recipientId: 'emp-1',
      input: {
        type: 'JOB_OFFER_EXPIRED' as const,
        recipientRole: 'EMPLOYER' as const,
        jobOfferId: 'offer-1',
        jobTitle: 'Comptable',
      },
    };

    notifyProfile(workerInAppEvents({ handleEvent }), payload);

    expect(handleEvent).toHaveBeenCalledWith(payload);
  });

  it('listens on the event notifyProfile emits', () => {
    const events = workerInAppEvents({ handleEvent: jest.fn() });

    expect(events.listenerCount(PROFILE_NOTIFICATION_EVENT)).toBe(1);
  });
});
