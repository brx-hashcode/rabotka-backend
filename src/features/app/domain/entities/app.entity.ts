import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../../core/domain/base-entity';

@Entity('app')
export class AppEntity extends BaseEntity {
  @Column({ length: 255 })
  greeting: string;

  @Column({ length: 64 })
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
