import { AppController } from '../app.controller';
import { AppService } from '../app.service';

describe('AppService', () => {
  it('getIndex returns welcome message', () => {
    const service = new AppService();
    const result = service.getIndex();
    expect(result.message).toBeDefined();
    expect(typeof result.message).toBe('string');
  });
});

describe('AppController', () => {
  it('getIndex delegates to AppService', () => {
    const service = new AppService();
    const controller = new AppController(service);
    const result = controller.getIndex();
    expect(result.message).toBeDefined();
  });
});
