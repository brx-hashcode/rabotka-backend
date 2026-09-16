import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ListProfileNotificationsDto } from '../dto/list-profile-notifications.dto';

/** Same options as the global pipe in main.ts. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const validate = (query: Record<string, string>) =>
  pipe.transform(query, {
    type: 'query',
    metatype: ListProfileNotificationsDto,
  }) as Promise<ListProfileNotificationsDto>;

describe('ListProfileNotificationsDto', () => {
  it('accepts the web client’s cache-buster', async () => {
    // Every GET from rabotka-client carries `_=<timestamp>`; this 400'd the feed.
    const dto = await validate({ page: '1', limit: '20', _: '17895555091957' });
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
  });

  it('still rejects unknown params', async () => {
    await expect(validate({ foo: 'bar' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('caps the page size', async () => {
    await expect(validate({ limit: '500' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
