import { resolveMx } from 'node:dns/promises';
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'hasMxRecord', async: true })
export class HasMxRecordConstraint implements ValidatorConstraintInterface {
  async validate(email: string): Promise<boolean> {
    if (!email?.includes('@')) return false;

    const domain = email.split('@')[1];
    try {
      const records = await resolveMx(domain);
      return records.length > 0;
    } catch {
      return false;
    }
  }

  defaultMessage(): string {

    return "L'email fourni n'est pas valide. Utilisez un email valide.";
  }
}

export function HasMxRecord(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: HasMxRecordConstraint,
    });
  };
}
