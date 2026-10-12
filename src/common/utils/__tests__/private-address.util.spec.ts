import {
  isPrivateAddress,
  resolvesToPrivateAddress,
} from '../private-address.util';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '[::1]',
    'not-an-ip',
  ])('treats %s as internal', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '41.202.219.1', '2606:4700::1111'])(
    'treats %s as public',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe('resolvesToPrivateAddress', () => {
  const lookupTo = (...addresses: string[]) =>
    jest
      .fn()
      .mockResolvedValue(addresses.map((address) => ({ address, family: 4 })));

  it('is false when every address is public', async () => {
    await expect(
      resolvesToPrivateAddress('partner.example', lookupTo('93.184.216.34')),
    ).resolves.toBe(false);
  });

  it('is true when any address is internal (DNS rebinding)', async () => {
    await expect(
      resolvesToPrivateAddress(
        'partner.example',
        lookupTo('93.184.216.34', '10.0.0.5'),
      ),
    ).resolves.toBe(true);
  });

  it('is true when the name does not resolve', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      resolvesToPrivateAddress('nowhere.example', failing),
    ).resolves.toBe(true);
  });

  it('checks an IP literal without a lookup', async () => {
    const lookup = jest.fn();
    await expect(resolvesToPrivateAddress('127.0.0.1', lookup)).resolves.toBe(
      true,
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});
