export const MIN_HOURS_FROM_NOW = 4;

const DATE_TIME_REGEX = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/;

export function parseDateTime(input: string): Date | null {
  const trimmed = input.trim();
  const match = DATE_TIME_REGEX.exec(trimmed);
  if (!match) return null;
  const [, day, month, year, hour, min] = match;
  if (!day || !month || !year || !hour || !min) return null;
  const dayN = Number.parseInt(day, 10);
  const monN = Number.parseInt(month, 10);
  const yrN = Number.parseInt(year, 10);
  const hrN = Number.parseInt(hour, 10);
  const minN = Number.parseInt(min, 10);
  if (monN < 1 || monN > 12) return null;
  if (dayN < 1 || dayN > 31) return null;
  if (hrN > 23 || minN > 59) return null;
  const d = new Date(yrN, monN - 1, dayN, hrN, minN);
  // Reject overflow (e.g. Feb 30 → March)
  if (d.getMonth() !== monN - 1) return null;
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toScheduledAtString(scheduledAt: unknown): string {
  if (scheduledAt instanceof Date) return scheduledAt.toISOString();
  if (typeof scheduledAt === 'string') return scheduledAt;
  return '';
}

export function formatDateTime(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
