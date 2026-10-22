import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ProfileCreateClaimDto } from '../dto/profile-create-claim.dto';

/**
 * Pentest A2-F16 (#872): a profile could pick the staff member assigned to
 * its own claim by sending assigned_user_id. The profile DTO no longer has
 * the field, so the app's global pipe refuses it.
 */
describe('ProfileCreateClaimDto', () => {
  // The app's own settings (main.ts).
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const validate = (body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype: ProfileCreateClaimDto });

  it('accepts what a complainant writes', async () => {
    await expect(
      validate({ title: 'Paiement', description: 'Pas reçu' }),
    ).resolves.toMatchObject({ title: 'Paiement' });
  });

  it.each([
    ['assigned_user_id', '6f1c1b1e-2c2f-4c55-9b7a-0d0a1b2c3d4e'],
    ['profile_id', '6f1c1b1e-2c2f-4c55-9b7a-0d0a1b2c3d4e'],
  ])('refuses the staff-only field %s', async (field, value) => {
    await expect(
      validate({ title: 'Paiement', description: 'Pas reçu', [field]: value }),
    ).rejects.toThrow(BadRequestException);
  });
});
