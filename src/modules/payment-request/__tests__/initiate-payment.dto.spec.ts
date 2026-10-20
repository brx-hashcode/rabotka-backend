import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InitiatePaymentDto } from '../dto/initiate-payment.dto';

const errorsFor = async (body: Record<string, unknown>) =>
  (await validate(plainToInstance(InitiatePaymentDto, body))).map(
    (e) => e.property,
  );

describe('InitiatePaymentDto', () => {
  it("accepts any network code — which ones are live is the service's check", async () => {
    // Not in any list in code: enabled on pawaPay, so it must get through.
    expect(
      await errorsFor({ phone: '+241077123456', operator: 'AIRTEL_GAB' }),
    ).toEqual([]);
    expect(
      await errorsFor({ phone: '+221771234567', operator: 'ORANGE_SEN' }),
    ).toEqual([]);
  });

  it('refuses something that is not a network code', async () => {
    expect(
      await errorsFor({ phone: '+242061234567', operator: 'mtn; drop' }),
    ).toEqual(['operator']);
  });

  it('still lets a gateway without networks omit it', async () => {
    expect(await errorsFor({ phone: '+242061234567' })).toEqual([]);
  });
});
