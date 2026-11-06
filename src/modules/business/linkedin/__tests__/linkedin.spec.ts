import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MailboxCrypto } from '../../mailbox/mailbox-crypto';
import { linkedinCallbackPage } from '../linkedin-callback-page';
import {
  linkedinAuthUrl,
  postBody,
  postUrl,
  toLittleText,
} from '../linkedin-api';
import {
  careersOfferUrl,
  EXPIRED_MESSAGE,
  excerpt,
  LinkedinService,
  personOf,
} from '../linkedin.service';

const KEY = randomBytes(32).toString('base64');

describe('LinkedIn API helpers', () => {
  it('asks for sign-in and member posts, with the state', () => {
    const url = new URL(linkedinAuthUrl('cid', 'https://b/cb', 'st'));
    expect(url.origin + url.pathname).toBe(
      'https://www.linkedin.com/oauth/v2/authorization',
    );
    expect(url.searchParams.get('scope')).toBe(
      'openid profile w_member_social',
    );
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('redirect_uri')).toBe('https://b/cb');
  });

  it('escapes little-text markup and keeps hashtags as hashtags', () => {
    expect(toLittleText('Poste (CDI) @Brazzaville <urgent>')).toBe(
      'Poste \\(CDI\\) \\@Brazzaville \\<urgent\\>',
    );
    expect(toLittleText('#recrutement #emploi_cg')).toBe(
      '{hashtag|\\#|recrutement} {hashtag|\\#|emploi_cg}',
    );
    expect(toLittleText('100 # pas un tag')).toBe('100 \\# pas un tag');
  });

  it('posts an article card to the careers page, thumbnail when there is one', () => {
    const body = postBody({
      authorUrn: 'urn:li:person:abc',
      text: 'Nous recrutons',
      url: 'https://business.rabotka.work/carrieres/akieni/OF-1?source=linkedin',
      title: 'Comptable — Akieni',
      description: 'Tenue de la comptabilité',
      thumbnail: null,
    });
    expect(body).toMatchObject({
      author: 'urn:li:person:abc',
      visibility: 'PUBLIC',
      lifecycleState: 'PUBLISHED',
      distribution: { feedDistribution: 'MAIN_FEED' },
      content: {
        article: {
          source:
            'https://business.rabotka.work/carrieres/akieni/OF-1?source=linkedin',
          title: 'Comptable — Akieni',
        },
      },
    });
    expect(body.content.article).not.toHaveProperty('thumbnail');
    const withPicture = postBody({
      authorUrn: 'a',
      text: '',
      url: 'u',
      title: 't',
      description: 'd',
      thumbnail: 'urn:li:image:1',
    });
    expect(withPicture.content.article).toHaveProperty(
      'thumbnail',
      'urn:li:image:1',
    );
  });

  it('links a post by its URN', () => {
    expect(postUrl('urn:li:share:7')).toBe(
      'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7/',
    );
  });
});

describe('linkedin helpers', () => {
  it('names the account holder « holder », a member by its id', () => {
    expect(personOf(undefined)).toBe('holder');
    expect(personOf('m-1')).toBe('m-1');
  });

  it('tags the careers link as LinkedIn', () => {
    expect(careersOfferUrl('akieni', 'OF-1')).toMatch(
      /\/carrieres\/akieni\/OF-1\?source=linkedin$/,
    );
  });

  it('cuts the description to one line', () => {
    expect(excerpt('a\n\n b   c')).toBe('a b c');
    expect(excerpt('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('tells its opener how the connection went', () => {
    expect(linkedinCallbackPage('connected')).toContain(
      '{ rabotkaLinkedin: "connected" }',
    );
    expect(linkedinCallbackPage('denied')).toContain('Connexion annulée');
  });
});

describe('LinkedinService', () => {
  const crypto = new MailboxCrypto(KEY);
  const jwt = new JwtService({ secret: 'test-secret' });
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const publicBusiness = {
    profile_id: 'p-1',
    name: 'Akieni',
    public_slug: 'akieni',
    verification_status: 'VERIFIED',
    deleted_at: null,
  };
  const offer = {
    title: 'Comptable',
    description: 'Tenue de la comptabilité',
    reference: 'OF-1',
  };
  const account = (over: Record<string, unknown> = {}) => ({
    id: 'la-1',
    business_id: 'biz-1',
    person: 'holder',
    linkedin_sub: 'abc',
    name: 'Awa Mbemba',
    access_token_enc: crypto.seal('li-token'),
    expires_at: new Date(Date.now() + 86_400_000),
    expired_at: null,
    ...over,
  });

  function make(env: Record<string, string | undefined> = {}) {
    const config = {
      get: (k: string) =>
        ({
          MAILBOX_TOKEN_KEY: KEY,
          LINKEDIN_CLIENT_ID: 'cid',
          LINKEDIN_CLIENT_SECRET: 'secret',
          ...env,
        })[k],
    };
    const prisma: any = {
      businessLinkedinAccount: {
        findUnique: jest.fn().mockResolvedValue(account()),
        upsert: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      jobOfferLinkedinPost: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'post-1', status: 'QUEUED' }),
        update: jest.fn().mockResolvedValue({
          offer_id: 'o-1',
          author_name: 'Awa Mbemba',
          offer: { title: 'Comptable', employer_id: 'p-1' },
        }),
      },
      business: { findUnique: jest.fn().mockResolvedValue(publicBusiness) },
      jobOffer: { findFirst: jest.fn().mockResolvedValue(offer) },
    };
    const subscriptions: any = {
      businessOf: jest.fn().mockResolvedValue('biz-1'),
    };
    const queue: any = { addJob: jest.fn(), createWorker: jest.fn() };
    const events: any = { emit: jest.fn() };
    const service = new LinkedinService(
      prisma,
      jwt,
      subscriptions,
      queue,
      events,
      config as any,
    );
    return { service, prisma, queue, events };
  }

  it('is not offered without the app credentials or the token key', async () => {
    expect(make({ LINKEDIN_CLIENT_SECRET: undefined }).service.available).toBe(
      false,
    );
    expect(make({ MAILBOX_TOKEN_KEY: undefined }).service.available).toBe(
      false,
    );
    await expect(
      make({ LINKEDIN_CLIENT_ID: '' }).service.account('p-1', undefined),
    ).resolves.toEqual({ available: false, account: null });
  });

  it('connects the signed-in person: a member by its id, sealed token', async () => {
    const { service, prisma } = make();
    const { url } = await service.connectUrl('p-1', 'm-7');
    const state = new URL(url).searchParams.get('state')!;

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'li-token', expires_in: 5_184_000 }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sub: 'abc',
            name: 'Awa Mbemba',
            picture: 'https://p',
          }),
        ),
      ) as never;

    await expect(service.complete('code-1', state)).resolves.toEqual({
      name: 'Awa Mbemba',
    });
    const call = prisma.businessLinkedinAccount.upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      business_id_person: { business_id: 'biz-1', person: 'm-7' },
    });
    expect(call.create.access_token_enc).not.toContain('li-token');
    expect(crypto.open(call.create.access_token_enc)).toBe('li-token');
  });

  it('refuses a state that is not its own', async () => {
    const { service } = make();
    const forged = await jwt.signAsync(
      { b: 'biz-1', p: 'holder', n: 'x' },
      { audience: 'rabotka-mailbox-connect', expiresIn: '10m' },
    );
    await expect(service.complete('code', forged)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('queues a post of a public offer, once', async () => {
    const { service, prisma, queue } = make();
    await expect(
      service.queuePost('p-1', undefined, 'o-1', ' Nous recrutons '),
    ).resolves.toEqual({ id: 'post-1', status: 'QUEUED' });
    expect(
      prisma.jobOfferLinkedinPost.create.mock.calls[0][0].data,
    ).toMatchObject({
      offer_id: 'o-1',
      person: 'holder',
      author_name: 'Awa Mbemba',
      text: 'Nous recrutons',
    });
    expect(queue.addJob).toHaveBeenCalledWith('linkedin-post-queue', {
      postId: 'post-1',
    });

    prisma.jobOfferLinkedinPost.findFirst.mockResolvedValue({ id: 'old' });
    await expect(
      service.queuePost('p-1', undefined, 'o-1', 'x'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.queuePost('p-1', undefined, 'o-1', 'x', true),
    ).resolves.toMatchObject({ status: 'QUEUED' });
  });

  it('refuses an offer that is not on the careers page', async () => {
    const { service, prisma } = make();
    prisma.business.findUnique.mockResolvedValue({
      ...publicBusiness,
      verification_status: 'PENDING',
    });
    await expect(
      service.queuePost('p-1', undefined, 'o-1', 'x'),
    ).rejects.toBeInstanceOf(BadRequestException);

    prisma.business.findUnique.mockResolvedValue(publicBusiness);
    prisma.jobOffer.findFirst.mockResolvedValue(null);
    await expect(
      service.queuePost('p-1', undefined, 'o-1', 'x'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses without a live connection', async () => {
    const { service, prisma } = make();
    prisma.businessLinkedinAccount.findUnique.mockResolvedValue(
      account({ expired_at: new Date() }),
    );
    await expect(
      service.queuePost('p-1', undefined, 'o-1', 'x'),
    ).rejects.toThrow(EXPIRED_MESSAGE);
  });

  const queued = {
    id: 'post-1',
    status: 'QUEUED',
    offer_id: 'o-1',
    business_id: 'biz-1',
    person: 'holder',
    author_name: 'Awa Mbemba',
    text: 'Nous recrutons #emploi',
  };

  it('publishes: the card links the careers page, and the business is told', async () => {
    const { service, prisma, events } = make();
    prisma.jobOfferLinkedinPost.findUnique.mockResolvedValue(queued);
    const fetchMock = jest
      .fn()
      // The share picture is not reachable: posted without one.
      .mockResolvedValueOnce(new Response('nope', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 201,
          headers: { 'x-restli-id': 'urn:li:share:7' },
        }),
      );
    global.fetch = fetchMock as never;

    await service.process({ data: { postId: 'post-1' }, attemptsMade: 0 });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.linkedin.com/rest/posts');
    expect(init.headers.Authorization).toBe('Bearer li-token');
    const body = JSON.parse(init.body);
    expect(body.author).toBe('urn:li:person:abc');
    expect(body.commentary).toBe('Nous recrutons {hashtag|\\#|emploi}');
    expect(body.content.article.source).toMatch(
      /\/carrieres\/akieni\/OF-1\?source=linkedin$/,
    );
    expect(
      prisma.jobOfferLinkedinPost.update.mock.calls[0][0].data,
    ).toMatchObject({
      status: 'PUBLISHED',
      post_urn: 'urn:li:share:7',
    });
    expect(events.emit.mock.calls[0][1]).toMatchObject({
      recipientId: 'p-1',
      input: {
        type: 'LINKEDIN_POST',
        postUrl: 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7/',
      },
    });
  });

  it('marks the connection expired when LinkedIn refuses the token', async () => {
    const { service, prisma, events } = make();
    prisma.jobOfferLinkedinPost.findUnique.mockResolvedValue(queued);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 404 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 })) as never;

    await service.process({ data: { postId: 'post-1' }, attemptsMade: 0 });

    expect(prisma.businessLinkedinAccount.update).toHaveBeenCalledWith({
      where: { id: 'la-1' },
      data: { expired_at: expect.any(Date) },
    });
    expect(prisma.jobOfferLinkedinPost.update.mock.calls[0][0].data).toEqual({
      status: 'FAILED',
      error: EXPIRED_MESSAGE,
    });
    expect(events.emit.mock.calls[0][1].input.postUrl).toBeNull();
  });

  it('lets the queue retry LinkedIn outages, then gives up', async () => {
    const { service, prisma } = make();
    prisma.jobOfferLinkedinPost.findUnique.mockResolvedValue(queued);
    const outage = () =>
      jest
        .fn()
        .mockResolvedValueOnce(new Response('nope', { status: 404 }))
        .mockResolvedValueOnce(new Response('busy', { status: 503 })) as never;

    global.fetch = outage();
    await expect(
      service.process({ data: { postId: 'post-1' }, attemptsMade: 0 }),
    ).rejects.toThrow(/503/);
    expect(prisma.jobOfferLinkedinPost.update).not.toHaveBeenCalled();

    global.fetch = outage();
    await service.process({ data: { postId: 'post-1' }, attemptsMade: 2 });
    expect(
      prisma.jobOfferLinkedinPost.update.mock.calls[0][0].data.status,
    ).toBe('FAILED');
  });
});
