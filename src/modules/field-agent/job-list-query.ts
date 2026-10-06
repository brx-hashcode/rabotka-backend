import { EmploymentType } from '@prisma/client';
import type { JobSort } from './agent-zones';

/**
 * The raw string params of a job feed. A plain type, not a DTO class, so the
 * global ValidationPipe (forbidNonWhitelisted) leaves it alone and the lenient
 * parsers below decide what to keep.
 */
export type JobListQuery = {
  q?: string;
  country?: string;
  city?: string;
  employmentType?: string;
  category?: string;
  sort?: string;
  minAmount?: string;
  maxAmount?: string;
};

const SLUG = /^[a-z0-9-]{1,80}$/;
const MAX_VALUES = 20;

/**
 * Query-string parsing for the job feeds (`public/jobs`, `agent/jobs`).
 * Lenient on purpose: a filter link shared from an older version of the app
 * should still load, so unknown values are dropped rather than rejected.
 */

function list(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, MAX_VALUES);
}

export function parseEmploymentTypes(
  raw: string | undefined,
): EmploymentType[] | undefined {
  const known = new Set<string>(Object.values(EmploymentType));
  const values = list(raw)
    .map((v) => v.toUpperCase())
    .filter((v): v is EmploymentType => known.has(v));
  return values.length > 0 ? values : undefined;
}

export function parseCategorySlugs(
  raw: string | undefined,
): string[] | undefined {
  const values = list(raw)
    .map((v) => v.toLowerCase())
    .filter((v) => SLUG.test(v));
  return values.length > 0 ? values : undefined;
}

export function parseSort(raw: string | undefined): JobSort {
  return raw === 'start' ? 'start' : 'recent';
}

export function parseAmount(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}
