import { BadRequestException } from '@nestjs/common';
import { changedReviewedFields, legalFormAfterEdit } from '../business-edit';

const current = {
  name: 'Akieni',
  category: 'TPE',
  legalForm: 'EI',
  registrationNumber: null,
  taxId: 'NIU-1',
  statisticalId: null,
};

describe('changedReviewedFields', () => {
  it('lists only the reviewed fields whose value changes', () => {
    expect(
      changedReviewedFields(current, { name: 'Akieni SA', taxId: 'NIU-1' }),
    ).toEqual(['name']);
  });

  it('ignores contact-only edits and missing keys', () => {
    expect(changedReviewedFields(current, {})).toEqual([]);
  });

  it('counts clearing a reviewed field as a change', () => {
    expect(changedReviewedFields(current, { taxId: null })).toEqual(['taxId']);
  });
});

describe('legalFormAfterEdit', () => {
  it('keeps the current form when nothing about it changes', () => {
    expect(legalFormAfterEdit('TPE', 'EI', {})).toBe('EI');
  });

  it('refuses a form that does not fit the category', () => {
    expect(() =>
      legalFormAfterEdit('ASSOCIATION', null, { legalForm: 'SARL' }),
    ).toThrow(BadRequestException);
  });

  it('clears a form the new category no longer takes', () => {
    expect(
      legalFormAfterEdit('ASSOCIATION', 'EI', { category: 'ASSOCIATION' }),
    ).toBeNull();
  });

  it('clears the form on request', () => {
    expect(legalFormAfterEdit('TPE', 'EI', { legalForm: null })).toBeNull();
  });
});
