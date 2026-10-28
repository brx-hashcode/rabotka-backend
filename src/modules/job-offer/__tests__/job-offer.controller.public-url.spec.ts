import { JobOfferController } from '../job-offer.controller';

describe('JobOfferController.getById — public page link', () => {
  const offer = { id: 'o1', employer_id: 'owner', questions: [] };
  const service = { findById: jest.fn().mockResolvedValue(offer) };
  const pages = { publicUrl: jest.fn() };
  const controller = new JobOfferController(service as never, pages as never);
  const req = (profileId: string) => ({ user: { profileId } }) as never;

  it('gives the owner the link to share while the offer is open', async () => {
    pages.publicUrl.mockResolvedValue(
      'https://rabotka.work/emplois/offre/x-o1',
    );
    const got = await controller.getById(req('owner'), 'o1');
    expect(got).toMatchObject({
      public_url: 'https://rabotka.work/emplois/offre/x-o1',
    });
  });

  it('gives null once it is closed', async () => {
    pages.publicUrl.mockResolvedValue(null);
    const got = await controller.getById(req('owner'), 'o1');
    expect(got).toMatchObject({ public_url: null });
  });

  it('leaves it out for anyone else', async () => {
    const got = await controller.getById(req('worker'), 'o1');
    expect(got).not.toHaveProperty('public_url');
  });
});
