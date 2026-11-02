import { BadRequestException } from '@nestjs/common';
import { ProfileType } from '@prisma/client';
import { assertBusinessIsEmployer, isBusinessEmployer } from '../business-rules';

describe('assertBusinessIsEmployer', () => {
  it('refuses a worker flagged as a business', () => {
    expect(() => assertBusinessIsEmployer(ProfileType.WORKER, true)).toThrow(
      BadRequestException,
    );
  });

  it.each([
    [ProfileType.EMPLOYER, true],
    [ProfileType.EMPLOYER, false],
    [ProfileType.WORKER, false],
  ])('accepts %s with is_business=%s', (type, isBusiness) => {
    expect(() => assertBusinessIsEmployer(type, isBusiness)).not.toThrow();
  });
});

describe('isBusinessEmployer', () => {
  const live = {
    profile_type: ProfileType.EMPLOYER,
    is_business: true,
    deleted_at: null,
    business: { deleted_at: null },
  };

  it('opens the dashboard to a live business employer', () => {
    expect(isBusinessEmployer(live)).toBe(true);
  });

  it.each([
    ['a regular employer', { ...live, is_business: false }],
    ['a worker', { ...live, profile_type: ProfileType.WORKER }],
    ['an archived profile', { ...live, deleted_at: new Date() }],
    ['a flag without its business', { ...live, business: null }],
    ['an archived business', { ...live, business: { deleted_at: new Date() } }],
  ])('keeps it closed to %s', (_who, profile) => {
    expect(isBusinessEmployer(profile)).toBe(false);
  });
});
