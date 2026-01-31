import { BaseEntity } from '../../../../core/domain/base-entity';

export class AppEntity extends BaseEntity {
  greeting: string;
  language: string;

  constructor(greeting: string, language: string, id?: string) {
    super(id);
    this.greeting = greeting;
    this.language = language;
  }

  getFormattedGreeting(): string {
    return `${this.greeting} (${this.language})`;
  }
}
