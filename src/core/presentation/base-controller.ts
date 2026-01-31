import { Controller } from '@nestjs/common';

@Controller()
export abstract class BaseController {
  protected getRoutePrefix(): string {
    return '';
  }
}
