import { Logger } from '@nestjs/common';
import {
  NEVER_EXPOSE,
  isNeverExpose,
  project,
  projectMany,
} from '../projections';
import {
  APPLICATION_SUMMARY,
  JOB_OFFER_SUMMARY,
  PROFILE_STATE,
  UNLOCK_STATE,
} from '../dto';

const errorSpy = jest
  .spyOn(Logger.prototype, 'error')
  .mockImplementation(() => {});

beforeEach(() => errorSpy.mockClear());

describe('project', () => {
  it('keeps only the allow-listed fields', () => {
    const out = project(
      { first_name: 'Awa', profile_type: 'WORKER', secret_note: 'nope' },
      PROFILE_STATE,
      'owner',
      'PROFILE_STATE',
    );
    expect(out).toEqual({ first_name: 'Awa', profile_type: 'WORKER' });
  });

  // The property the whole layer exists for: a column added to Prisma next
  // sprint is invisible until somebody lists it.
  it('fails closed on a field nobody classified', () => {
    const out = project(
      { first_name: 'Awa', new_column_added_next_sprint: 'leak' },
      PROFILE_STATE,
      'owner',
      'PROFILE_STATE',
    );
    expect(out).not.toHaveProperty('new_column_added_next_sprint');
  });

  it('drops a phone number even when the record is otherwise allowed', () => {
    const out = project(
      { first_name: 'Awa', phone: '+242060000000', email: 'a@b.cg' },
      PROFILE_STATE,
      'owner',
      'PROFILE_STATE',
    );
    expect(out).toEqual({ first_name: 'Awa' });
  });

  it('scrubs a never-expose field hiding inside an allowed relation', () => {
    const out = project(
      {
        id: 'app-1',
        status: 'ACCEPTED',
        job_offer: {
          reference: 'RB-123',
          title: 'Plomberie',
          address: '12 rue X',
          employer: { first_name: 'Jean', phone: '+242060000001' },
        },
      },
      APPLICATION_SUMMARY,
      'owner',
      'APPLICATION_SUMMARY',
    );

    const offer = (out as any).job_offer;
    expect(offer.reference).toBe('RB-123');
    expect(offer).not.toHaveProperty('address');
    expect(offer.employer).toEqual({ first_name: 'Jean' });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('says nothing about another profile through an owner-only DTO', () => {
    const out = project(
      { first_name: 'Awa', reliability_score: 92 },
      PROFILE_STATE,
      'public',
      'PROFILE_STATE',
    );
    expect(out).toEqual({});
  });

  it('shows an offer identically to both audiences', () => {
    const raw = {
      reference: 'RB-9',
      title: 'Ménage',
      city: 'Brazzaville',
      address: 'secret',
    };
    const owner = project(raw, JOB_OFFER_SUMMARY, 'owner', 'JOB_OFFER');
    const other = project(raw, JOB_OFFER_SUMMARY, 'public', 'JOB_OFFER');
    expect(owner).toEqual(other);
    expect(owner).not.toHaveProperty('address');
  });

  // Revealing a contact is the contactUnlocked template's job, not the model's.
  it('never returns a contact through the unlock state, even once UNLOCKED', () => {
    const out = project(
      {
        status: 'UNLOCKED',
        expires_at: null,
        phone: '+242060000000',
        email: 'worker@example.cg',
      },
      UNLOCK_STATE,
      'owner',
      'UNLOCK_STATE',
    );
    expect(out).toEqual({ status: 'UNLOCKED', expires_at: null });
  });

  it('preserves dates and arrays rather than flattening them', () => {
    const scheduled = new Date('2026-09-01T08:00:00Z');
    const out = project(
      {
        scheduled_at: scheduled,
        title: 'x',
        category: [{ slug: 'plomberie' }],
      },
      JOB_OFFER_SUMMARY,
      'public',
      'JOB_OFFER',
    );
    expect((out as any).scheduled_at).toBe(scheduled);
    expect((out as any).category).toEqual([{ slug: 'plomberie' }]);
  });

  it('handles null and empty input', () => {
    expect(project(null, PROFILE_STATE, 'owner', 'X')).toBeNull();
    expect(projectMany([], PROFILE_STATE, 'owner', 'X')).toEqual([]);
    expect(projectMany(null, PROFILE_STATE, 'owner', 'X')).toEqual([]);
  });
});

describe('NEVER_EXPOSE', () => {
  it('covers the contact fields that are the revenue and safety model', () => {
    for (const field of [
      'phone',
      'email',
      'address',
      'latitude',
      'longitude',
    ]) {
      expect(isNeverExpose(field)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isNeverExpose('PHONE')).toBe(true);
    expect(isNeverExpose('Email')).toBe(true);
  });

  it('does not over-reach into fields the assistant needs', () => {
    for (const field of ['city', 'country_name', 'first_name', 'reference']) {
      expect(NEVER_EXPOSE.has(field)).toBe(false);
    }
  });
});
