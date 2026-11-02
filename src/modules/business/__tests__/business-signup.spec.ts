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
  it('accepts a PME with its RCCM and NIU', () => {
    expect(() =>
      assertBusinessSignupComplete({
        category: 'PME',
        legalForm: 'SARL',
        documents: [{ documentType: 'RCCM' }, { documentType: 'NIU' }],
      }),
    ).not.toThrow();
  });

  it('names the missing document', () => {
    expect(() =>
      assertBusinessSignupComplete({
        category: 'PME',
        documents: [{ documentType: 'RCCM' }],
      }),
    ).toThrow(/NIU/);
  });

  it('refuses a legal form that does not fit', () => {
    expect(() =>
      assertBusinessSignupComplete({
        category: 'PME',
        legalForm: 'PUBLIC_ENTITY',
        documents: [{ documentType: 'RCCM' }, { documentType: 'NIU' }],
      }),
    ).toThrow(BadRequestException);
  });
});
