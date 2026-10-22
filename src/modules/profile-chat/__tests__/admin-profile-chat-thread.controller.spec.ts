import { MessageModerationStatus, RedactionCategory } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { AdminConversationThreadController } from '../admin-profile-chat-thread.controller';

const CONV = 'c-1';
const ADMIN = 'u-9';
const WORKER = 'w-1';
const EMPLOYER = 'e-1';

/** "appelle moi au 06 12 34 56 78" — the digits run from 15 to 29. */
const BODY_WITH_PHONE = 'appelle moi au 06 12 34 56 78';

const thread = {
  data: [
    {
      id: 'm-1',
      senderId: WORKER,
      senderName: 'Sara Colombe',
      senderSide: 'WORKER' as const,
      body: BODY_WITH_PHONE,
      status: MessageModerationStatus.REDACTED,
      semanticFlagged: false,
      redactions: [
        {
          start: 15,
          end: 29,
          category: RedactionCategory.PHONE,
          matchedBy: 'cg_mobile',
        },
      ],
      reports: [],
      readAt: null,
      deletedAt: null,
      createdAt: '2026-09-23T10:00:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  limit: 50,
  workerId: WORKER,
  employerId: EMPLOYER,
};

const request = {
  user: { userId: ADMIN },
  // The address Cloudflare saw (#879), not a client-written X-Forwarded-For.
  headers: { 'cf-connecting-ip': '41.2.3.4' },
  ip: '10.0.0.1',
  get: (header: string) =>
    header.toLowerCase() === 'user-agent' ? 'Firefox' : undefined,
} as any;

describe('AdminConversationThreadController', () => {
  let controller: AdminConversationThreadController;
  let conversations: { messages: jest.Mock };
  let logService: { create: jest.Mock };

  beforeEach(() => {
    conversations = { messages: jest.fn().mockResolvedValue(thread) };
    logService = { create: jest.fn().mockResolvedValue(undefined) };
    controller = new AdminConversationThreadController(
      conversations as any,
      logService as any,
    );
  });

  it('returns the raw body, phone number and all', async () => {
    const result = await controller.messages(CONV, {}, request);

    expect(result.data[0].body).toContain('06 12 34 56 78');
    expect(result.data[0].redactions[0]).toMatchObject({
      start: 15,
      end: 29,
      matchedBy: 'cg_mobile',
    });
  });

  it('writes exactly one audit row, naming the conversation and the reader', async () => {
    await controller.messages(CONV, { page: 2 }, request);

    expect(logService.create).toHaveBeenCalledTimes(1);
    expect(logService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CONVERSATION_THREAD_READ',
        entityType: 'ProfileConversation',
        entityId: CONV,
        userId: ADMIN,
        ipAddress: '41.2.3.4',
        userAgent: 'Firefox',
      }),
    );
  });

  it('never copies message text into the log', async () => {
    // The feature exists to keep contact details out of circulation. Writing a
    // body into a table support staff can list would put them straight back in.
    await controller.messages(CONV, {}, request);

    const { metadata } = logService.create.mock.calls[0][0];
    expect(JSON.stringify(metadata)).not.toContain('06 12 34 56 78');
    expect(JSON.stringify(metadata)).not.toContain('appelle');
  });

  it('writes no row when the conversation does not exist', async () => {
    // Otherwise the audit trail doubles as a probe log: anybody with the role
    // could enumerate ids and leave a clean record of having found nothing.
    conversations.messages.mockRejectedValue(new NotFoundException());

    await expect(controller.messages(CONV, {}, request)).rejects.toThrow(
      NotFoundException,
    );
    expect(logService.create).not.toHaveBeenCalled();
  });
});
