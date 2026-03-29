import { Test } from '@nestjs/testing';
import { WsNotificationsGateway } from '../ws-notifications.gateway';
import { WsNotificationsListener } from '../ws-notifications.listener';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';

describe('WsNotificationsModule', () => {
  it('provides gateway and listener', async () => {
    const module = await Test.createTestingModule({
      providers: [
        WsNotificationsGateway,
        WsNotificationsListener,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: JwtService, useValue: { verify: jest.fn() } },
        { provide: REDIS_CONNECTION, useValue: {} },
      ],
    }).compile();

    expect(module.get(WsNotificationsGateway)).toBeDefined();
    expect(module.get(WsNotificationsListener)).toBeDefined();
  });
});
