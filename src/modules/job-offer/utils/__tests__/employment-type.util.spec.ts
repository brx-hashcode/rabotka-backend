import { EmploymentType } from '@prisma/client';
import {
  closesOnFill,
  EMPLOYMENT_LABEL,
  EMPLOYMENT_LABEL_EN,
  isDatedMission,
} from '../employment-type.util';

describe('employment types', () => {
  it('reads only a MISSION as dated: every other type is recruited, then closed', () => {
    for (const type of Object.values(EmploymentType)) {
      expect(isDatedMission(type)).toBe(type === EmploymentType.MISSION);
      expect(closesOnFill(type)).toBe(type !== EmploymentType.MISSION);
    }
  });

  it('falls back on a mission for a missing type, as it always did', () => {
    expect(isDatedMission(undefined)).toBe(true);
    expect(isDatedMission('')).toBe(true);
  });

  it('names every type, in French and in English', () => {
    for (const type of Object.values(EmploymentType)) {
      expect(EMPLOYMENT_LABEL[type]).toBeTruthy();
      expect(EMPLOYMENT_LABEL_EN[type]).toBeTruthy();
    }
    expect(EMPLOYMENT_LABEL.CONSULTANT).toBe('Consultant');
    expect(EMPLOYMENT_LABEL.INTERIM).toBe('Intérim');
  });
});
