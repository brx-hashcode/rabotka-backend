import { CMD_MENU } from '../bot.constants';

/**
 * Returns true if the input matches a global exit command (MENU variants).
 * Flows can call this instead of repeating the CMD_MENU inline check.
 * Note: the orchestrator already intercepts MENU globally; this is a
 * defensive fallback used in flows called directly (e.g., unit tests).
 */
export function isGlobalExit(normalized: string): boolean {
  return CMD_MENU.some(
    (c) => normalized === c || normalized.startsWith(c + ' '),
  );
}
