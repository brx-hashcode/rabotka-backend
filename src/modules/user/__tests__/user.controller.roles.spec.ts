import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { UserController } from '../user.controller';

const rolesOf = (method: keyof UserController): UserRole[] =>
  Reflect.getMetadata(
    ROLES_KEY,
    UserController.prototype[method],
  ) as UserRole[];

/**
 * Pentest A2-F11 (#867): bulk-restore was MANAGER, so a manager could bring
 * back archived ADMIN and SUPER_ADMIN accounts that only a SUPER_ADMIN may
 * archive. Restore now needs the same role as archive.
 */
describe('UserController — archive and restore need the same role', () => {
  it('restricts bulk-restore to SUPER_ADMIN', () => {
    expect(rolesOf('bulkRestore')).toEqual([UserRole.SUPER_ADMIN]);
  });

  it('matches bulk-delete', () => {
    expect(rolesOf('bulkRestore')).toEqual(rolesOf('bulkDelete'));
  });
});
