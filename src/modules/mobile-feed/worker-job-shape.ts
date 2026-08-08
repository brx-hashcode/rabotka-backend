import { EmploymentType } from '@prisma/client';

/**
 * The snake_case columns that the worker-facing job shape renames.
 *
 * `city` is deliberately absent: it is spelled the same either way, so it
 * passes straight through with the rest of the object.
 */
type RenamedColumns = {
  is_remote: boolean;
  employment_type: EmploymentType;
  country_name: string | null;
};

/**
 * The one place a job offer becomes the shape the worker app expects.
 *
 * These responses are mostly a snake_case passthrough of the Prisma row, but
 * three fields are exposed in camelCase, so a client reading them has to know
 * which convention applies to which key. Three endpoints built that object
 * independently and two got it wrong: `/profile/job-search` left all three out
 * of its explicit field list, and `/profile/saved-jobs` spread the service
 * result straight through in snake_case. Both made every result read as an
 * on-site MISSION regardless of what it was, because the client's `??` defaults
 * turned the resulting `undefined` into exactly that.
 *
 * Renaming in one function means the three endpoints cannot disagree again.
 */
export function toWorkerJobShape<T extends RenamedColumns>(
  offer: T,
): Omit<T, keyof RenamedColumns> & {
  isRemote: boolean;
  employmentType: EmploymentType;
  countryName: string | null;
} {
  const { is_remote, employment_type, country_name, ...rest } = offer;
  return {
    ...rest,
    isRemote: is_remote,
    employmentType: employment_type,
    countryName: country_name,
  };
}
