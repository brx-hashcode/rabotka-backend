import { Logger } from '@nestjs/common';
import {
  PROFILE_READS,
  SYSTEM_CONFIG_READS,
  UNLOCK_READS,
  WALLET_READS,
  readOnly,
} from '../read-only';

jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

describe('readOnly', () => {
  const wallet = {
    getProfileWalletBalance: jest.fn().mockResolvedValue(100),
    debitProfileWallet: jest.fn(),
    creditProfileWallet: jest.fn(),
    payAllPenaltiesWithWallet: jest.fn(),
  };

  it('allows the reads the assistant is meant to make', async () => {
    const guarded = readOnly(wallet, WALLET_READS, 'wallet');
    await expect(guarded.getProfileWalletBalance('p-1')).resolves.toBe(100);
  });

  // The whole point: a balance may be READ, never changed.
  it.each([
    'debitProfileWallet',
    'creditProfileWallet',
    'payAllPenaltiesWithWallet',
  ])('blocks %s at runtime', (method) => {
    const guarded = readOnly(wallet, WALLET_READS, 'wallet') as Record<
      string,
      unknown
    >;
    expect(() => guarded[method]).toThrow(/read-only/);
  });

  it('throws rather than returning undefined, so a no-op cannot be reported as success', () => {
    const guarded = readOnly(wallet, WALLET_READS, 'wallet') as Record<
      string,
      unknown
    >;
    expect(() => guarded.somethingInvented).toThrow(/read-only/);
  });

  it('refuses assignment too', () => {
    const guarded = readOnly(wallet, WALLET_READS, 'wallet') as Record<
      string,
      unknown
    >;
    expect(() => {
      guarded.getProfileWalletBalance = jest.fn();
    }).toThrow(/read-only/);
  });

  it('keeps `this` bound, so a guarded method still works', async () => {
    class Service {
      private readonly value = 42;
      getContactInfo() {
        return Promise.resolve({
          email: `e${this.value}`,
          phone: '',
          address: '',
        });
      }
      set() {
        throw new Error('should never run');
      }
    }
    const guarded = readOnly(
      new Service(),
      SYSTEM_CONFIG_READS,
      'systemConfig',
    );
    await expect(guarded.getContactInfo()).resolves.toEqual({
      email: 'e42',
      phone: '',
      address: '',
    });
  });

  it('blocks the profile and unlock writes the platform owns', () => {
    const profiles = readOnly(
      {
        findById: jest.fn(),
        updateProfile: jest.fn(),
        verifyProfileKyc: jest.fn(),
      },
      PROFILE_READS,
      'profiles',
    ) as Record<string, unknown>;
    expect(() => profiles.updateProfile).toThrow(/read-only/);
    expect(() => profiles.verifyProfileKyc).toThrow(/read-only/);

    const unlock = readOnly(
      {
        getByApplicationId: jest.fn(),
        payUnlock: jest.fn(),
        initiateUnlock: jest.fn(),
      },
      UNLOCK_READS,
      'unlock',
    ) as Record<string, unknown>;
    expect(() => unlock.payUnlock).toThrow(/read-only/);
    expect(() => unlock.initiateUnlock).toThrow(/read-only/);
  });
});
