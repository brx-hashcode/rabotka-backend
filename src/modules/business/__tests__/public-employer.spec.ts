import {
  publicEmployerContact,
  publicEmployerFullName,
  publicEmployerName,
} from '../public-employer';

const person = {
  first_name: 'Jean',
  last_name: 'Luc',
  phone: '+242060000001',
  email: 'jean@x.cg',
};

describe('public employer', () => {
  it('names a business by its organisation', () => {
    const e = {
      ...person,
      is_business: true,
      business: {
        name: 'LOVE LIFE WITH US',
        phone: '+242050000002',
        email: 'contact@love.cg',
        deleted_at: null,
      },
    };
    expect(publicEmployerName(e)).toEqual({
      first_name: 'LOVE LIFE WITH US',
      last_name: '',
    });
    expect(publicEmployerFullName(e)).toBe('LOVE LIFE WITH US');
    expect(publicEmployerContact(e)).toEqual({
      phone: '+242050000002',
      email: 'contact@love.cg',
    });
  });

  it("falls back to the account's details the organisation did not give", () => {
    const e = {
      ...person,
      is_business: true,
      business: { name: 'Love', phone: null, email: '  ', deleted_at: null },
    };
    expect(publicEmployerContact(e)).toEqual({
      phone: person.phone,
      email: person.email,
    });
  });

  it('keeps a person, a non-business and an archived business as the person', () => {
    expect(publicEmployerFullName(person)).toBe('Jean Luc');
    expect(
      publicEmployerFullName({
        ...person,
        is_business: false,
        business: { name: 'X' },
      }),
    ).toBe('Jean Luc');
    expect(
      publicEmployerFullName({
        ...person,
        is_business: true,
        business: { name: 'X', deleted_at: new Date() },
      }),
    ).toBe('Jean Luc');
  });
});
