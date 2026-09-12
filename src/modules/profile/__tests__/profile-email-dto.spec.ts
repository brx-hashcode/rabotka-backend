import { plainToInstance } from 'class-transformer';
import { CreateProfileDto } from '../dto/create-profile.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { AdminUpdateProfileDto } from '../dto/admin-update-profile.dto';

/**
 * `Profile.email` is optional: most of the informal sector signs up with a phone
 * and no email address. These cases pin the three states the field has to carry
 * — absent, cleared, and present — through `plainToInstance`, which is exactly
 * what `ValidationPipe` (`transform: true`) does to the request body.
 *
 * Going through the real transform matters here for the reason documented in
 * `claim.service.spec.ts`: the DTO is a class, and target ES2023 implies
 * `useDefineForClassFields`, so an instance carries EVERY declared key whatever
 * the client sent. A transform that collapsed a missing key into `null` would
 * therefore make every unrelated profile edit silently wipe the user's email,
 * and an object literal in a test would never catch it.
 */
describe('profile email DTO transforms', () => {
  describe('CreateProfileDto', () => {
    it('leaves email unset when the client omits it', () => {
      const dto = plainToInstance(CreateProfileDto, {
        firstName: 'Pascal',
        lastName: 'Sanscourriel',
        phone: '+242069917686',
      });

      // `undefined`, not `null`: class-transformer does not run `@Transform`
      // for a key the client never sent. `createProfileRecord` coerces with
      // `?? null` so the column gets an explicit NULL either way.
      expect(dto.email).toBeUndefined();
    });

    it('maps an empty string to null rather than storing ""', () => {
      // The column is UNIQUE and Postgres treats '' as an ordinary value, so
      // two emailless signups holding '' would collide. Many NULLs are fine.
      const dto = plainToInstance(CreateProfileDto, { email: '   ' });

      expect(dto.email).toBeNull();
    });

    it('trims and lowercases an address that is provided', () => {
      const dto = plainToInstance(CreateProfileDto, {
        email: '  Alice@Example.COM ',
      });

      expect(dto.email).toBe('alice@example.com');
    });
  });

  describe('UpdateProfileDto', () => {
    it('leaves email undefined when the key is absent, so an edit cannot wipe it', () => {
      const dto = plainToInstance(UpdateProfileDto, { firstName: 'Pascal' });

      // Present as a class field, but undefined — which is what the service
      // reads as "untouched". Were this null, a name change would clear the
      // user's email.
      expect('email' in dto).toBe(true);
      expect(dto.email).toBeUndefined();
    });

    it('treats an empty string as a deliberate clear', () => {
      const dto = plainToInstance(UpdateProfileDto, { email: '' });

      expect(dto.email).toBeNull();
    });

    it('treats an explicit null as a deliberate clear', () => {
      const dto = plainToInstance(UpdateProfileDto, { email: null });

      expect(dto.email).toBeNull();
    });

    it('trims and lowercases an address that is provided', () => {
      const dto = plainToInstance(UpdateProfileDto, {
        email: ' Worker@Example.COM ',
      });

      expect(dto.email).toBe('worker@example.com');
    });
  });

  describe('AdminUpdateProfileDto', () => {
    // It used to redeclare `email` with `@IsOptional() @IsEmail()` alone — no
    // lowercase transform. Since the unique index is case-sensitive, that let an
    // admin write `Alice@x.com` beside an existing `alice@x.com` and create the
    // duplicate the constraint exists to prevent. It now inherits instead.
    it('inherits the normalising transform rather than redeclaring a weaker one', () => {
      const dto = plainToInstance(AdminUpdateProfileDto, {
        email: ' Alice@Example.COM ',
      });

      expect(dto.email).toBe('alice@example.com');
    });

    it('can clear an email, and leaves it untouched when absent', () => {
      expect(
        plainToInstance(AdminUpdateProfileDto, { email: '' }).email,
      ).toBeNull();
      expect(
        plainToInstance(AdminUpdateProfileDto, { phone: '+242069917686' })
          .email,
      ).toBeUndefined();
    });
  });
});
