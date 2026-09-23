import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  ListConversationsDto,
  ListMessagesDto,
  SendMessageDto,
} from '../dto/profile-chat.dto';

/** Same options as the global pipe in main.ts. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const validate = <T>(metatype: new () => T, value: unknown, type: 'query' | 'body' = 'query') =>
  pipe.transform(value, { type, metatype }) as Promise<T>;

describe('profile chat DTOs', () => {
  describe.each([
    ['ListConversationsDto', ListConversationsDto, 20],
    ['ListMessagesDto', ListMessagesDto, 50],
  ] as const)('%s', (_name, metatype, defaultLimit) => {
    it('accepts the web client’s cache-buster', async () => {
      // EVERY GET from rabotka-client carries `_=<timestamp>`, and
      // forbidNonWhitelisted 400s the whole screen without this. It is the
      // second time this exact bug has shipped here — see
      // list-profile-notifications.dto.spec.ts — so it gets a test on both
      // DTOs rather than a comment.
      const dto = await validate(metatype, {
        page: '1',
        limit: '20',
        _: '179007373418424',
      });
      expect(dto.page).toBe(1);
      expect(dto.limit).toBe(20);
    });

    it('defaults sensibly on an empty query', async () => {
      const dto = await validate(metatype, {});
      expect(dto.page).toBe(1);
      expect(dto.limit).toBe(defaultLimit);
    });

    it('still rejects an unknown parameter', async () => {
      await expect(validate(metatype, { foo: 'bar' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('caps the page size', async () => {
      await expect(validate(metatype, { limit: '500' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('SendMessageDto', () => {
    it('accepts an ordinary message', async () => {
      const dto = await validate(
        SendMessageDto,
        { body: 'bonjour, je suis disponible lundi' },
        'body',
      );
      expect(dto.body).toBe('bonjour, je suis disponible lundi');
    });

    it.each([[{}], [{ body: '' }], [{ body: '   ' }]])(
      'rejects an empty body: %p',
      async (payload) => {
        await expect(
          validate(SendMessageDto, payload, 'body'),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it('rejects a body past the length bound', async () => {
      // Tighter than the detector's own 4000-character scan cap, on purpose:
      // the product rule has to be the tighter of the two or the engine bound
      // would be reachable from outside.
      await expect(
        validate(SendMessageDto, { body: 'a'.repeat(2001) }, 'body'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
