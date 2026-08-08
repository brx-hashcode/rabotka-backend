import { ValidationPipe } from '@nestjs/common';
import { AdminListProfilesDto } from '../../../modules/profile/dto/admin-list-profiles.dto';
import { GraphQueryDto } from '../../../modules/collaboration-graph/dto/graph-query.dto';
import { parseBooleanQueryValue } from '../query-boolean.util';

/**
 * Mirrors the global pipe in main.ts. `enableImplicitConversion` is the whole
 * point of this suite: it coerces `boolean` properties with `Boolean(value)`
 * before custom transforms run, and `Boolean('false')` is `true`.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

function transform<T>(
  metatype: new () => T,
  query: Record<string, string>,
): Promise<T> {
  return pipe.transform(query, { type: 'query', metatype }) as Promise<T>;
}

describe('parseBooleanQueryValue', () => {
  it('parses the truthy and falsy spellings', () => {
    expect(parseBooleanQueryValue('true')).toBe(true);
    expect(parseBooleanQueryValue('1')).toBe(true);
    expect(parseBooleanQueryValue(true)).toBe(true);
    expect(parseBooleanQueryValue('false')).toBe(false);
    expect(parseBooleanQueryValue('0')).toBe(false);
    expect(parseBooleanQueryValue(false)).toBe(false);
  });

  it('returns undefined for anything it does not recognise', () => {
    expect(parseBooleanQueryValue(undefined)).toBeUndefined();
    expect(parseBooleanQueryValue(null)).toBeUndefined();
    expect(parseBooleanQueryValue('')).toBeUndefined();
    expect(parseBooleanQueryValue('yes')).toBeUndefined();
  });
});

describe('boolean query flags through the global ValidationPipe', () => {
  it('keeps whatsapp_connected=false false', async () => {
    const dto = await transform(AdminListProfilesDto, {
      whatsapp_connected: 'false',
    });
    expect(dto.whatsapp_connected).toBe(false);
  });

  it('keeps whatsapp_connected=true true', async () => {
    const dto = await transform(AdminListProfilesDto, {
      whatsapp_connected: 'true',
    });
    expect(dto.whatsapp_connected).toBe(true);
  });

  it('leaves whatsapp_connected unset when the filter is absent', async () => {
    const dto = await transform(AdminListProfilesDto, { page: '1' });
    expect(dto.whatsapp_connected).toBeUndefined();
  });

  it('keeps deleted=false false', async () => {
    const dto = await transform(AdminListProfilesDto, { deleted: 'false' });
    expect(dto.deleted).toBe(false);
  });

  it('keeps deleted=true true', async () => {
    const dto = await transform(AdminListProfilesDto, { deleted: 'true' });
    expect(dto.deleted).toBe(true);
  });

  it('keeps the graph include toggles off when set to false', async () => {
    const dto = await transform(GraphQueryDto, {
      includeApplications: 'false',
      includeContacts: 'false',
    });
    expect(dto.includeApplications).toBe(false);
    expect(dto.includeContacts).toBe(false);
  });

  it('defaults the graph include toggles to on', async () => {
    const dto = await transform(GraphQueryDto, {});
    expect(dto.includeApplications ?? true).toBe(true);
    expect(dto.includeContacts ?? true).toBe(true);
  });
});
