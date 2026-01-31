import { Injectable } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { BaseUseCase } from '../../../../core/application/base-use-case.interface';
import { GetHelloDto } from '../dto/get-hello.dto';
import { AppEntity } from '../../domain/entities/app.entity';

@Injectable()
export class GetHelloUseCase extends BaseUseCase<GetHelloDto, AppEntity> {
  constructor(private readonly i18n: I18nService) {
    super();
  }

  execute(input: GetHelloDto): Promise<AppEntity> {
    this.validate(input);

    const message: string = this.i18n.t('common.app.greeting', {
      lang: input.language,
    });

    return Promise.resolve(new AppEntity(message, input.language));
  }

  protected validate(input: GetHelloDto): void {
    if (!input.language) {
      throw new Error('Language is required');
    }
  }
}
