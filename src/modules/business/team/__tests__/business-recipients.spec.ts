import { businessEmailRecipients } from '../business-recipients';

describe('businessEmailRecipients', () => {
  const db = (
    holderOn: boolean | null,
    members: { email: string; name: string; is_owner?: boolean }[],
  ) =>
    ({
      business: {
        findUnique: jest.fn().mockResolvedValue({
          profile: { email: 'Jean@ZuaFood.cg', first_name: 'Jean' },
        }),
      },
      businessMember: {
        findMany: jest
          .fn()
          .mockResolvedValue(members.map((m) => ({ is_owner: false, ...m }))),
        findFirst: jest
          .fn()
          .mockResolvedValue(
            holderOn === null ? null : { emails_on: holderOn },
          ),
      },
    }) as any;

  it('writes to the holder and to each member who keeps e-mails on, by first name', async () => {
    const d = db(true, [{ email: 'awa@e.cg', name: 'Awa Mbemba' }]);
    await expect(
      businessEmailRecipients(d, 'b', 'recruiting'),
    ).resolves.toEqual([
      { email: 'jean@zuafood.cg', name: 'Jean' },
      { email: 'awa@e.cg', name: 'Awa' },
    ]);
    expect(d.businessMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { business_id: 'b', status: 'ACTIVE', emails_on: true },
      }),
    );
  });

  it('keeps the plan and payments for the administrator', async () => {
    const d = db(true, []);
    await businessEmailRecipients(d, 'b', 'billing');
    expect(d.businessMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: 'ADMIN' }),
      }),
    );
  });

  it('leaves out a holder who switched its e-mails off, and keeps them on before the team existed', async () => {
    await expect(
      businessEmailRecipients(db(false, []), 'b', 'recruiting'),
    ).resolves.toEqual([]);
    await expect(
      businessEmailRecipients(db(null, []), 'b', 'recruiting'),
    ).resolves.toEqual([{ email: 'jean@zuafood.cg', name: 'Jean' }]);
  });
});
