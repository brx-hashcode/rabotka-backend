import { handleMenuCommand } from '../menu.command';
import {
  workerMenuMessage,
  employerMenuMessage,
} from '../../messages/menu.messages';
import type { BotProfile } from '../../types/bot-state.types';

describe('handleMenuCommand', () => {
  it('returns worker menu for WORKER profile', () => {
    const profile = { profile_type: 'WORKER' } as BotProfile;
    expect(handleMenuCommand(profile)).toBe(workerMenuMessage());
  });

  it('returns employer menu for EMPLOYER profile', () => {
    const profile = { profile_type: 'EMPLOYER' } as BotProfile;
    expect(handleMenuCommand(profile)).toBe(employerMenuMessage());
  });
});
