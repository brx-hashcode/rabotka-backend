import { jobOfferPublishedMessage } from '../job-offer-published';
import { paymentApprovedMessage } from '../payment-approved';
import { verificationSuccessMessage } from '../verification-success';
import {
  paymentUseRegisteredNumberPrompt,
  paymentEnterPhonePrompt,
  paymentChooseOperatorPrompt,
  paymentPendingMessage,
  paymentDirectFailedMessage,
} from '../payment-direct';
import {
  verifyWhatsAppMessage,
  whatsappVerifyCodeMessage,
} from '../verify-whatsapp';

describe('WhatsApp Templates', () => {
  describe('jobOfferPublishedMessage', () => {
    it('generates message with name and job title', () => {
      const msg = jobOfferPublishedMessage('Alice', 'Plombier');
      expect(msg).toContain('Alice');
      expect(msg).toContain('Plombier');
    });
  });

  describe('paymentApprovedMessage', () => {
    it('generates payment approved message', () => {
      const msg = paymentApprovedMessage('Bob');
      expect(msg).toContain('Bob');
      expect(msg).toContain('paiement');
    });
  });

  describe('verificationSuccessMessage', () => {
    it('generates verification success message', () => {
      const msg = verificationSuccessMessage();
      expect(msg).toContain('vérifié');
    });
  });

  describe('payment-direct templates', () => {
    it('generates registered number prompt', () => {
      const msg = paymentUseRegisteredNumberPrompt('+242000001');
      expect(msg).toContain('+242000001');
      expect(msg).toContain('1');
      expect(msg).toContain('2');
    });

    it('generates enter phone prompt', () => {
      const msg = paymentEnterPhonePrompt();
      expect(msg).toContain('numéro');
    });

    it('generates choose operator prompt', () => {
      const msg = paymentChooseOperatorPrompt();
      expect(msg).toContain('MTN');
      expect(msg).toContain('Airtel');
    });

    it('generates payment pending message', () => {
      const msg = paymentPendingMessage(5000, 'MTN', '+242000001');
      expect(msg).toContain('5');
      expect(msg).toContain('MTN');
      expect(msg).toContain('+242000001');
    });

    it('generates payment failed message', () => {
      const msg = paymentDirectFailedMessage('https://pay.example.com');
      expect(msg).toContain('pay.example.com');
    });
  });
});
