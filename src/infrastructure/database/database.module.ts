import { Module, Global } from '@nestjs/common';

@Global()
@Module({
  imports: [],
  providers: [],
  exports: [],
})
export class DatabaseModule {
  static forRoot() {
    return {
      module: DatabaseModule,
      providers: [],
      exports: [],
    };
  }
}
