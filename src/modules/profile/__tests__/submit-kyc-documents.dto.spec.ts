import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SubmitKycDocumentsDto } from '../dto/submit-kyc-documents.dto';

const failedFields = async (body: Record<string, unknown>) =>
  (await validate(plainToInstance(SubmitKycDocumentsDto, body))).map(
    (e) => e.property,
  );

const full = {
  documentType: 'IDENTITY_CARD',
  kycDocumentUrl: 'https://cdn.example.com/kyc-documents/front.jpg',
  kycDocumentBackUrl: 'https://cdn.example.com/kyc-documents/back.jpg',
  kycSelfieUrl: 'https://cdn.example.com/kyc-documents/selfie.jpg',
};

describe('SubmitKycDocumentsDto', () => {
  it('accepts a full set', async () => {
    expect(await failedFields(full)).toEqual([]);
  });

  it('wants the back of every document but a passport', async () => {
    expect(
      await failedFields({ ...full, kycDocumentBackUrl: undefined }),
    ).toEqual(['kycDocumentBackUrl']);
    expect(
      await failedFields({
        ...full,
        documentType: 'PASSPORT',
        kycDocumentBackUrl: undefined,
      }),
    ).toEqual([]);
  });

  it('treats blank and null as missing', async () => {
    expect(
      await failedFields({
        ...full,
        kycSelfieUrl: '   ',
        kycDocumentUrl: null,
      }),
    ).toEqual(expect.arrayContaining(['kycSelfieUrl', 'kycDocumentUrl']));
  });

  it('refuses an unknown document type', async () => {
    expect(await failedFields({ ...full, documentType: 'CNI' })).toEqual([
      'documentType',
    ]);
  });
});
