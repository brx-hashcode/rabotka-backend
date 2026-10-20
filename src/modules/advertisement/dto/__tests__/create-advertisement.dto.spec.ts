import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAdvertisementDto } from '../create-advertisement.dto';
import { UpdateAdvertisementDto } from '../update-advertisement.dto';
import { MAX_AD_IMAGES } from '../../advertisement.constants';

const urls = (n: number) =>
  Array.from({ length: n }, (_, i) => `https://cdn.example.com/ad-${i}.webp`);

const imageErrors = async (
  cls: typeof CreateAdvertisementDto | typeof UpdateAdvertisementDto,
  imageUrls: string[],
) =>
  (await validate(plainToInstance(cls, { imageUrls }))).filter(
    (e) => e.property === 'imageUrls',
  );

describe('advertisement imageUrls limit', () => {
  it(`accepts up to ${MAX_AD_IMAGES} images`, async () => {
    expect(
      await imageErrors(CreateAdvertisementDto, urls(MAX_AD_IMAGES)),
    ).toEqual([]);
  });

  it('refuses one more, on create and on update', async () => {
    for (const cls of [CreateAdvertisementDto, UpdateAdvertisementDto]) {
      const errors = await imageErrors(cls, urls(MAX_AD_IMAGES + 1));
      expect(errors).toHaveLength(1);
      expect(Object.values(errors[0].constraints ?? {})).toContain(
        `Une publicité compte au plus ${MAX_AD_IMAGES} images`,
      );
    }
  });
});
