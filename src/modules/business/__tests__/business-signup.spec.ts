import { BusinessDocumentType } from '@prisma/client';
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

/** The signup's papers, by type. */
const papers = (...types: BusinessDocumentType[]) =>
  types.map((documentType) => ({ documentType }));

describe('assertBusinessSignupComplete', () => {
  it('accepts an organisation with its required papers and no address', () => {
    expect(() =>
      assertBusinessSignupComplete(
        {
          category: 'PME',
          legalForm: 'SARL',
          documents: papers('RCCM', 'NIU'),
        },
        'cg',
      ),
    ).not.toThrow();
    // In the RDC, the F92 receipt stands for the arrêté still to come.
    expect(() =>
      assertBusinessSignupComplete(
        {
          category: 'ASSOCIATION',
          documents: papers('RECEPISSE', 'STATUTS'),
        },
        'CD',
      ),
    ).not.toThrow();
  });

  it('refuses a sign-up without its required papers, naming them locally', () => {
    expect(() =>
      assertBusinessSignupComplete(
        { category: 'PME', legalForm: 'SARL', documents: [] },
        'CG',
      ),
    ).toThrow('Ajoutez « Extrait du RCCM » et « Attestation NIU »');
    expect(() =>
      assertBusinessSignupComplete(
        { category: 'STARTUP', documents: papers('RCCM') },
        'SN',
      ),
    ).toThrow('Ajoutez « Attestation NINEA »');
    expect(() =>
      assertBusinessSignupComplete(
        { category: 'ASSOCIATION', documents: papers('STATUTS') },
        'CD',
      ),
    ).toThrow(/« Arrêté ministériel .* » ou « Récépissé F92/);
  });

  it('asks a Rwandan company for the RDB certificate alone: it carries the TIN', () => {
    expect(() =>
      assertBusinessSignupComplete(
        { category: 'PME', legalForm: 'SARL', documents: papers('RCCM') },
        'RW',
      ),
    ).not.toThrow();
  });

  it('asks a school for its licence and the paper of its legal form', () => {
    const school =
      (legalForm: 'SARL' | 'ASSOCIATION', ...t: BusinessDocumentType[]) =>
      () =>
        assertBusinessSignupComplete(
          { category: 'SCHOOL', legalForm, documents: papers(...t) },
          'CM',
        );
    expect(school('SARL', 'AUTORISATION_OUVERTURE', 'RCCM')).not.toThrow();
    expect(school('ASSOCIATION', 'AGREMENT', 'RECEPISSE')).not.toThrow();
    expect(school('SARL', 'AUTORISATION_OUVERTURE', 'RECEPISSE')).toThrow(
      /Extrait du RCCM/,
    );
    expect(school('ASSOCIATION', 'RECEPISSE')).toThrow(/Autorisation/);
  });

  it('refuses a legal form that does not fit', () => {
    expect(() =>
      assertBusinessSignupComplete(
        { category: 'PME', legalForm: 'PUBLIC_ENTITY', documents: [] },
        'CG',
      ),
    ).toThrow(BadRequestException);
  });

  it('needs a country, even online, and one Rabotka Business is open in', () => {
    const startup = { category: 'STARTUP' as const, documents: [] };
    expect(() => assertBusinessSignupComplete(startup, undefined)).toThrow(
      /Choisissez le pays/,
    );
    expect(() => assertBusinessSignupComplete(startup, ' ')).toThrow(
      /Choisissez le pays/,
    );
    expect(() => assertBusinessSignupComplete(startup, 'NG')).toThrow(
      /disponible dans ces pays/,
    );
    // Closed to sign-up: no mobile money the gateway collects.
    expect(() => assertBusinessSignupComplete(startup, 'TD')).toThrow(
      /disponible dans ces pays/,
    );
  });

  it('checks the legal form against the country: no SAS in Kenya', () => {
    expect(() =>
      assertBusinessSignupComplete(
        { category: 'STARTUP', legalForm: 'SAS', documents: [] },
        'KE',
      ),
    ).toThrow(/ne correspond pas/);
    expect(() =>
      assertBusinessSignupComplete(
        {
          category: 'STARTUP',
          legalForm: 'SARL',
          documents: papers('RCCM', 'NIU'),
        },
        'KE',
      ),
    ).not.toThrow();
  });
});
