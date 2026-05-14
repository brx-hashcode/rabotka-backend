import { isGlobalExit } from '../flow-helpers';

describe('isGlobalExit', () => {
  it('returns true for "menu"', () => {
    expect(isGlobalExit('menu')).toBe(true);
  });

  it('returns true for "aide"', () => {
    expect(isGlobalExit('aide')).toBe(true);
  });

  it('returns true for command with space', () => {
    expect(isGlobalExit('menu extra')).toBe(true);
  });

  it('returns false for regular input', () => {
    expect(isGlobalExit('hello')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isGlobalExit('')).toBe(false);
  });

  it('returns false for partial match without space', () => {
    expect(isGlobalExit('menuextra')).toBe(false);
  });
});
