import { invoiceClient } from '../invoice.service';

const owner = {
  first_name: 'Jean',
  last_name: 'Luc',
  email: 'jean@x.cg',
  phone: '+242060000001',
};
const business = {
  name: 'LOVE LIFE WITH US',
  phone: '+242050000002',
  email: null,
  tax_id: 'M2400001',
  registration_number: 'CG-BZV-01-2026',
  address: '19 rue Niari',
  city: 'Brazzaville',
  deleted_at: null,
};

describe('invoiceClient', () => {
  it('bills a business as its organisation', () => {
    expect(
      invoiceClient({ ...owner, is_business: true, business }),
    ).toMatchObject({
      FIRST_NAME: 'LOVE LIFE WITH US',
      LAST_NAME: '',
      PHONE: '+242050000002',
      // No e-mail of its own: the account's.
      EMAIL: 'jean@x.cg',
      BUSINESS_NIU: 'M2400001',
      BUSINESS_ADDRESS: '19 rue Niari, Brazzaville',
      ACCOUNT_HOLDER: 'Jean Luc',
    });
  });

  it('bills anyone else as themselves', () => {
    expect(
      invoiceClient({ ...owner, is_business: false, business: null }),
    ).toMatchObject({
      FIRST_NAME: 'Jean',
      LAST_NAME: 'Luc',
      PHONE: '+242060000001',
      BUSINESS_NAME: '-',
    });
  });
});
