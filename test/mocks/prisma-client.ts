export class PrismaClient {
  constructor(_options?: any) {}
}

export enum AccountStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  BANNED = 'BANNED',
}

export enum ProfileType {
  WORKER = 'WORKER',
  EMPLOYER = 'EMPLOYER',
}

export enum JobOfferStatus {
  ACTIVE = 'ACTIVE',
  FILLED = 'FILLED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
}

export enum ApplicationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

export enum PaymentFlow {
  HOURLY = 'HOURLY',
  DAILY = 'DAILY',
  MONTHLY = 'MONTHLY',
}

export enum PaymentType {
  REGISTRATION = 'REGISTRATION',
  JOB_POSTING = 'JOB_POSTING',
  PENALTY = 'PENALTY',
}

export enum PaymentMethod {
  MOBILE_MONEY = 'MOBILE_MONEY',
  CARD = 'CARD',
  OTHER = 'OTHER',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
}

export enum VerificationStatus {
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

export enum WalletOwnerType {
  SYSTEM = 'SYSTEM',
  USER = 'USER',
  PROFILE = 'PROFILE',
}

export enum WalletTransactionType {
  CREDIT_PENALTY = 'CREDIT_PENALTY',
  CREDIT_COMMISSION = 'CREDIT_COMMISSION',
}
