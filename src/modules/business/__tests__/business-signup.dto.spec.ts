import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateProfileDto } from '../../profile/dto/create-profile.dto';

// The MX lookup is network I/O; what is under test is which fields apply.
jest.mock('../../../common/validators/has-mx-record.validator', () => ({
  HasMxRecord: () => () => undefined,
}));

const base = {
  firstName: 'Awa',
  lastName: 'Mabiala',
  email: 'contact@ecole.cg',
  phone: '+242061234567',
  address: 'Brazzaville',
  profileType: 'EMPLOYER',
  readAndApprovedPolicies: true,
  signupToken: 'token',
};

const failedFields = async (body: object) =>
  (await validate(plainToInstance(CreateProfileDto, body))).map(
    (e) => e.property,
  );

describe('CreateProfileDto, business sign-up', () => {
  const business = {
    name: 'École Les Lauriers',
    category: 'SCHOOL',
    address: 'Brazzaville',
    documents: [
      {
        documentType: 'AGREMENT',
        url: 'https://cdn.example.com/kyc-documents/a.pdf',
      },
    ],
  };

  it('needs no personal ID or selfie', async () => {
    expect(await failedFields({ ...base, business })).toEqual([]);
  });

  it('still needs them without a business', async () => {
    expect(await failedFields(base)).toEqual(
      expect.arrayContaining([
        'documentType',
        'kycDocumentUrl',
        'kycSelfieUrl',
      ]),
    );
  });

  it('validates the business itself', async () => {
    expect(
      await failedFields({
        ...base,
        business: { ...business, category: 'BAKERY', documents: [{}] },
      }),
    ).toEqual(['business']);
  });
});
