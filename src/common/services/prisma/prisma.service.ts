import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const DEFAULT_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5433/rabotka';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    @Optional()
    @Inject(ConfigService)
    private readonly configService: ConfigService | null,
  ) {
    const connectionString =
      configService?.get<string>('DATABASE_URL') ??
      process.env.DATABASE_URL ??
      DEFAULT_DATABASE_URL;
    const adapter = new PrismaPg({
      connectionString,
      connectionTimeoutMillis: 15_000,
      max: 10,
    });
    super({
      adapter,
      // `sandbox_client_secret_plaintext` is a client secret in the clear. It
      // is legitimate for exactly two readers — the reveal endpoint and the
      // `canCopySecret` flag on the admin list — and a leak everywhere else.
      //
      // Omitting it globally means the field is genuinely ABSENT from every
      // `oAuthApp` result, so a future `return app` from some new detail route
      // serialises a row without it rather than disclosing a credential. The
      // two legitimate readers ask for it by name with
      // `omit: { sandbox_client_secret_plaintext: false }`.
      //
      // This is a RUNTIME guarantee, not a compile-time one. `PrismaService
      // extends PrismaClient` without passing the options as a type argument,
      // so TypeScript still types the field as present — verified, not assumed.
      // The compile-time half comes from `OAuthAppRow` in `oauth-app.service`,
      // which narrows what callers of that service can reach, and from the
      // canary test in `admin-oauth-app.controller.spec.ts`.
      omit: { oAuthApp: { sandbox_client_secret_plaintext: true } },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
