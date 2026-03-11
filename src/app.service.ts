import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getIndex(): { message: string } {
    return { message: "Bienvenue ! L'API Rabotka est prête à vous servir." };
  }
}
