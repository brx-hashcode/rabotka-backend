import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCvScreeningDto } from '../dto/create-cv-screening.dto';

const check = async (body: Record<string, unknown>) => {
  const dto = plainToInstance(CreateCvScreeningDto, body);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
};

describe('CreateCvScreeningDto.mailAttachments', () => {
  const ref = {
    mailboxId: '6f1b8e1e-0000-4000-8000-000000000000',
    messageId: '18f2c',
    attachmentId: '1.2',
  };

  it('reads the JSON a multipart form sends', async () => {
    const { dto, errors } = await check({
      jobTitle: 'Serveur',
      mailAttachments: JSON.stringify([ref]),
    });
    expect(errors).toEqual([]);
    expect(dto.mailAttachments).toEqual([ref]);
  });

  it('refuses more than 5, a bad mailbox id, or an unknown field', async () => {
    expect(
      (await check({ mailAttachments: JSON.stringify(Array(6).fill(ref)) }))
        .errors,
    ).not.toEqual([]);
    expect(
      (
        await check({
          mailAttachments: JSON.stringify([{ ...ref, mailboxId: 'x' }]),
        })
      ).errors,
    ).not.toEqual([]);
    expect(
      (await check({ mailAttachments: JSON.stringify([{ ...ref, url: 'x' }]) }))
        .errors,
    ).not.toEqual([]);
    expect((await check({ mailAttachments: 'not json' })).errors).not.toEqual(
      [],
    );
  });
});
