import { BaseEntity } from '../../../core/domain/base-entity';
import { IBaseRepository } from '../../../core/infrastructure/base-repository.interface';

export abstract class BaseRepository<
  T extends BaseEntity,
> implements IBaseRepository<T> {
  protected abstract getEntityName(): string;

  abstract findById(id: string): Promise<T | null>;
  abstract findAll(): Promise<T[]>;
  abstract create(entity: Partial<T>): Promise<T>;
  abstract update(id: string, entity: Partial<T>): Promise<T>;
  abstract delete(id: string): Promise<void>;

  async exists(id: string): Promise<boolean> {
    const entity = await this.findById(id);
    return entity !== null;
  }
}
