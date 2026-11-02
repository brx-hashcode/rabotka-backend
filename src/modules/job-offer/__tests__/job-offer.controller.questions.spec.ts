import { JobOfferController } from '../job-offer.controller';

describe('JobOfferController.getById — offer questions', () => {
  const offer = {
    id: 'o1',
    employer_id: 'owner',
    questions: [
      {
        id: 'q1',
        kind: 'YES_NO',
        label: 'Avez-vous le permis B ?',
        options: [],
        required: true,
        knockout: true,
        accepted: ['yes'],
      },
    ],
  };
  const controller = new JobOfferController({
    findById: jest.fn().mockResolvedValue(offer),
  } as never);
  const req = (profileId: string) => ({ user: { profileId } }) as never;

  it('shows the owner which answers are accepted', async () => {
    const got = await controller.getById(req('owner'), 'o1');
    expect(got.questions?.[0]).toMatchObject({
      knockout: true,
      accepted: ['yes'],
    });
  });

  it('hides them from anyone else, candidates first', async () => {
    const got = await controller.getById(req('worker'), 'o1');
    expect(got.questions?.[0]).toEqual({
      id: 'q1',
      kind: 'YES_NO',
      label: 'Avez-vous le permis B ?',
      options: [],
      required: true,
    });
  });
});
