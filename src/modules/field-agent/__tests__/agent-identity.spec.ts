import { DocumentType, KycDocumentCategory } from '@prisma/client';
import {
  isAgentAvatarKey,
  isAgentKycKey,
  normalizeAgentEmail,
  normalizeIdDocumentNumber,
  requiredKycCategories,
} from '../agent-identity';
import {
  AGENT_CANDIDATE_SELECT,
  AGENT_JOB_SELECT,
  PUBLIC_JOB_SELECT,
  AGENT_SELF_SELECT,
} from '../agent-selects';

describe('agent identity rules', () => {
  it('normalises the login email', () => {
    expect(normalizeAgentEmail('  Agent@Example.COM ')).toBe(
      'agent@example.com',
    );
  });

  it('makes typing variants of one ID number compare equal', () => {
    expect(normalizeIdDocumentNumber('ab 123-456.7/8')).toBe('AB12345678');
    expect(normalizeIdDocumentNumber('AB12345678')).toBe('AB12345678');
  });

  describe('isAgentKycKey', () => {
    it('accepts a key from the agents KYC folder', () => {
      expect(isAgentKycKey('kyc-documents/agents/1700_abc.jpg')).toBe(true);
    });

    it.each([
      // A profile's document: same bucket, different owner.
      'kyc-documents/1700_abc.jpg',
      'kyc-verification/p1/1700_abc.jpg',
      // Climbing out, or an empty segment.
      'kyc-documents/agents/../1700_abc.jpg',
      'kyc-documents/agents//x.jpg',
      // The public bucket's folders.
      'avatars/agents/x.jpg',
      '/kyc-documents/agents/x.jpg',
      '',
    ])('refuses %p', (key) => {
      expect(isAgentKycKey(key)).toBe(false);
    });
  });

  it('only accepts avatars from the agents avatar folder', () => {
    expect(isAgentAvatarKey('avatars/agents/x.webp')).toBe(true);
    expect(isAgentAvatarKey('avatars/x.webp')).toBe(false);
    expect(isAgentAvatarKey('avatars/agents/../x.webp')).toBe(false);
    expect(isAgentAvatarKey('kyc-documents/agents/x.jpg')).toBe(false);
  });

  it('needs no back for a passport, and all three otherwise', () => {
    expect(requiredKycCategories(DocumentType.PASSPORT)).toEqual([
      KycDocumentCategory.DOCUMENT,
      KycDocumentCategory.SELFIE,
    ]);
    expect(requiredKycCategories(DocumentType.IDENTITY_CARD)).toEqual([
      KycDocumentCategory.DOCUMENT,
      KycDocumentCategory.DOCUMENT_BACK,
      KycDocumentCategory.SELFIE,
    ]);
  });
});

/**
 * The privacy rule of the agent app, held structurally: nothing an agent can
 * receive has an employer relation or a worker contact field in its select.
 */
describe('agent selects', () => {
  const keysDeep = (o: object): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === 'object' ? [k, ...keysDeep(v as object)] : [k],
    );

  it('never selects the employer of a job', () => {
    expect(keysDeep(AGENT_JOB_SELECT)).not.toContain('employer');
    expect(keysDeep(AGENT_JOB_SELECT)).not.toContain('employer_id');
  });

  it('gives signed-in agents the note, never the public page', () => {
    // The note (« Note complémentaire ») reaches workers too, and an agent
    // pitching the job needs it. The public page is read by anyone.
    expect(keysDeep(AGENT_JOB_SELECT)).toContain('note');
    expect(keysDeep(PUBLIC_JOB_SELECT)).not.toContain('note');
  });

  it('never selects a worker contact detail', () => {
    for (const field of ['phone', 'direct_phone', 'email', 'address']) {
      expect(keysDeep(AGENT_CANDIDATE_SELECT)).not.toContain(field);
    }
  });

  it('does not expose the ID document to the agent themselves', () => {
    expect(keysDeep(AGENT_SELF_SELECT)).not.toContain('id_document_number');
    expect(keysDeep(AGENT_SELF_SELECT)).not.toContain('kyc_documents');
  });
});
