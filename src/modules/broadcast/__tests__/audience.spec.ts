import { AccountStatus, ProfileType, VerificationStatus } from '@prisma/client';
import { buildAudienceWhere } from '../audience';

/** The AND arm holding the guards every audience gets, whatever the filters. */
function guards(where: ReturnType<typeof buildAudienceWhere>) {
  return (where.AND as Record<string, unknown>[]) ?? [];
}

describe('buildAudienceWhere', () => {
  it('excludes deleted and opted-out profiles even for empty filters', () => {
    const where = buildAudienceWhere({});

    // The two rules an admin must not be able to switch off by leaving a field
    // blank. An empty filter set is a legitimate audience — "everyone" — and it
    // still must not reach a deleted account or someone who said STOP.
    expect(guards(where)).toContainEqual({ deleted_at: null });
    expect(guards(where)).toContainEqual({ marketing_opt_out_at: null });
  });

  it('defaults to ACTIVE profiles only', () => {
    const where = buildAudienceWhere({});

    const [criteria] = guards(where);
    expect(criteria.status).toBe(AccountStatus.ACTIVE);
  });

  it('lets an explicit status list override the ACTIVE default', () => {
    const where = buildAudienceWhere({
      statuses: [AccountStatus.SUSPENDED, AccountStatus.ACTIVE],
    });

    const [criteria] = guards(where);
    expect(criteria.status).toEqual({
      in: [AccountStatus.SUSPENDED, AccountStatus.ACTIVE],
    });
  });

  it('keeps the opt-out guard when it is explicitly waived', () => {
    // `respectOptOut: false` exists for an operational message, and even then
    // deletion is not negotiable.
    const where = buildAudienceWhere({}, { respectOptOut: false });

    expect(guards(where)).toContainEqual({ deleted_at: null });
    expect(guards(where)).not.toContainEqual({ marketing_opt_out_at: null });
  });

  it('matches cities case-insensitively', () => {
    const where = buildAudienceWhere({ cities: ['Poto-Poto'] });

    // City is free text on the profile, so an equality match would split one
    // neighbourhood into as many audiences as there are spellings.
    const [criteria] = guards(where);
    expect(criteria.OR).toEqual([
      { city: { equals: 'Poto-Poto', mode: 'insensitive' } },
    ]);
  });

  it('adds explicitly included profiles alongside the filters, not inside them', () => {
    const where = buildAudienceWhere({
      profile_types: [ProfileType.WORKER],
      include_profile_ids: ['p1'],
    });

    // An OR, so naming someone widens the audience by exactly them rather than
    // making them satisfy every other criterion.
    const [criteria] = guards(where) as [{ OR: Record<string, unknown>[] }];
    expect(criteria.OR).toHaveLength(2);
    expect(criteria.OR[1]).toEqual({ id: { in: ['p1'] } });
  });

  it('applies exclusions after inclusions, so exclusion wins', () => {
    const where = buildAudienceWhere({
      include_profile_ids: ['p1'],
      exclude_profile_ids: ['p1'],
    });

    expect(guards(where)).toContainEqual({ id: { notIn: ['p1'] } });
  });

  it('turns active_within_days into a last_login_at floor', () => {
    const before = Date.now();
    const where = buildAudienceWhere({ active_within_days: 30 });
    const [criteria] = guards(where) as [{ last_login_at: { gte: Date } }];

    const expected = before - 30 * 24 * 60 * 60 * 1000;
    expect(criteria.last_login_at.gte.getTime()).toBeGreaterThanOrEqual(
      expected - 1_000,
    );
    expect(criteria.last_login_at.gte.getTime()).toBeLessThanOrEqual(
      expected + 1_000,
    );
  });

  it('reads has_email in both directions', () => {
    const withEmail = guards(buildAudienceWhere({ has_email: true }))[0];
    const without = guards(buildAudienceWhere({ has_email: false }))[0];

    expect(withEmail.email).toEqual({ not: null });
    expect(without.email).toBeNull();
  });

  it('passes verification and category filters through', () => {
    const [criteria] = guards(
      buildAudienceWhere({
        verification_statuses: [VerificationStatus.VERIFIED],
        category_ids: ['cat-1'],
      }),
    );

    expect(criteria.verification_status).toEqual({
      in: [VerificationStatus.VERIFIED],
    });
    expect(criteria.category_id).toEqual({ in: ['cat-1'] });
  });
});
