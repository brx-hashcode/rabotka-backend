import { Injectable } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';

@Injectable()
export class AppService {
  constructor(private readonly i18n: I18nService) {}

  getIndex(language: string): { message: string; language: string } {
    const message = this.i18n.t('common.app.greeting', {
      lang: language,
    });

    return { message, language };
  }
}
