export abstract class BaseEntity {
  id?: string;
  createdAt?: Date;
  updatedAt?: Date;

  constructor(id?: string) {
    this.id = id;
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  touch(): void {
    this.updatedAt = new Date();
  }

  equals(other: BaseEntity): boolean {
    if (!other || !this.id || !other.id) {
      return false;
    }
    return this.id === other.id;
  }
}
