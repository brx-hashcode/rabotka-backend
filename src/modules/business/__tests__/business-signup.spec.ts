import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  assertBusinessSignupComplete,
  signupEntryFor,
} from '../business-signup';

const body = {
  phone: '+242061234567',
  email: 'contact@ecole.cg',
  profileType: 'EMPLOYER' as const,
};

describe('signupEntryFor', () => {
  it('is a WhatsApp sign-up when the token proved the phone', () => {
    expect(signupEntryFor({ entry: 'whatsapp', phone: body.phone }, body)).toBe(
      'whatsapp',
    );
  });

  it('is a business sign-up when the token proved the email', () => {
    expect(
      signupEntryFor(
        { entry: 'business', email: body.email },
        { ...body, business: {} },
      ),
    ).toBe('business');
  });

  it('refuses without a token, or with one for another number', () => {
    expect(() => signupEntryFor(null, body)).toThrow(ForbiddenException);
    expect(() =>
      signupEntryFor({ entry: 'whatsapp', phone: '+242000000000' }, body),
    ).toThrow(ForbiddenException);
  });

  it('never lets a body make a WhatsApp sign-up a business', () => {
    expect(() =>
      signupEntryFor(
        { entry: 'whatsapp', phone: body.phone },
        { ...body, business: {} },
      ),
    ).toThrow(BadRequestException);
  });

  it('holds a business token to its email, its business, and the employer role', () => {
    const token = { entry: 'business', email: body.email } as const;
    expect(() =>
      signupEntryFor(token, { ...body, email: 'x@y.cg', business: {} }),
    ).toThrow(ForbiddenException);
    expect(() => signupEntryFor(token, { ...body, email: null })).toThrow(
      ForbiddenException,
    );
    expect(() => signupEntryFor(token, body)).toThrow(BadRequestException);
    expect(() =>
      signupEntryFor(token, {
        ...body,
        profileType: 'WORKER',
        business: {},
      }),
    ).toThrow(BadRequestException);
  });
});

describe('assertBusinessSignupComplete', () => {
  it('accepts an organisation with no document and no address', () => {
    expect(() =>
      assertBusinessSignupComplete({ category: 'ASSOCIATION' }, 'CD'),
    ).not.toThrow();
    expect(() =>
      assertBusinessSignupComplete(
        { category: 'PME', legalForm: 'SARL' },
        'cg',
      ),
    ).not.toThrow();
  });

  it('refuses a legal form that does not fit', () => {
    expect(() =>
      assertBusinessSignupComplete(
        { category: 'PME', legalForm: 'PUBLIC_ENTITY' },
        'CG',
      ),
    ).toThrow(BadRequestException);
  });

  it('needs a country, even online, and one Rabotka Business is open in', () => {
    expect(() =>
      assertBusinessSignupComplete({ category: 'STARTUP' }, undefined),
    ).toThrow(/Choisissez le pays/);
    expect(() =>
      assertBusinessSignupComplete({ category: 'STARTUP' }, ' '),
    ).toThrow(/Choisissez le pays/);
    expect(() =>
      assertBusinessSignupComplete({ category: 'STARTUP' }, 'NG'),
    ).toThrow(/disponible dans ces pays/);
    // Closed to sign-up: no mobile money the gateway collects.
    expect(() =>
      assertBusinessSignupComplete({ category: 'STARTUP' }, 'TD'),
    ).toThrow(/disponible dans ces pays/);
  });

  it('checks the legal form against the country: no SAS in Kenya', () => {
    expect(() =>
      assertBusinessSignupComplete(
        { category: 'STARTUP', legalForm: 'SAS' },
        'KE',
      ),
    ).toThrow(/ne correspond pas/);
    expect(() =>
      assertBusinessSignupComplete(
        { category: 'STARTUP', legalForm: 'SARL' },
        'KE',
      ),
    ).not.toThrow();
  });
});
