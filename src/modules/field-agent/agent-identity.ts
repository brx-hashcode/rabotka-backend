import { DocumentType, KycDocumentCategory } from '@prisma/client';
import { isKycKey } from '../../common/services/storage/kyc-key';

/**
 * Pure rules about an agent's identity: how fields are normalised, which
 * storage keys an admin may attach, and which documents make a complete file.
 *
 * No Nest imports, so they are tested directly and shared by every service
 * that writes an agent.
 */

/**
 * Where agent identity documents are written in the private KYC bucket.
 *
 * Under `kyc-documents/` on purpose: `isKycKey` already recognises that prefix,
 * so every existing safeguard that asks "is this an identity document?" answers
 * yes for these too without being taught a new folder.
 */
export const AGENT_KYC_FOLDER = 'kyc-documents/agents';

/** Agent avatars, in the public bucket beside profile avatars. */
export const AGENT_AVATAR_FOLDER = 'avatars/agents';

export function normalizeAgentEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The number as printed, without the separators people type it with, so that
 * "AB 123-456" and "ab123456" are the same document — the uniqueness index
 * compares this form.
 */
export function normalizeIdDocumentNumber(value: string): string {
  return value.toUpperCase().replace(/[\s.\-/]/g, '');
}

/**
 * Whether `key` names an object this module put in the agents' KYC folder.
 *
 * The admin sends back the key the upload endpoint returned; this is what stops
 * a crafted request from attaching some profile's passport — or any other
 * object in the bucket — to an agent.
 */
export function isAgentKycKey(key: string): boolean {
  return (
    key.startsWith(`${AGENT_KYC_FOLDER}/`) &&
    !key.includes('..') &&
    isKycKey(key)
  );
}

export function isAgentAvatarKey(key: string): boolean {
  return key.startsWith(`${AGENT_AVATAR_FOLDER}/`) && !key.includes('..');
}

/**
 * The documents a complete agent file needs. A passport carries everything on
 * its photo page and has no back, as for profiles (see KycDocumentCategory).
 */
export function requiredKycCategories(
  documentType: DocumentType,
): KycDocumentCategory[] {
  return documentType === DocumentType.PASSPORT
    ? [KycDocumentCategory.DOCUMENT, KycDocumentCategory.SELFIE]
    : [
        KycDocumentCategory.DOCUMENT,
        KycDocumentCategory.DOCUMENT_BACK,
        KycDocumentCategory.SELFIE,
      ];
}
