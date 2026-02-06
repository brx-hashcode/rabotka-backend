import { escapeHtml, wrapEmailHtml } from './layout.js';

export function sendWelcomeEmail(name: string): string {
  const body = `<p>Hi ${escapeHtml(name)},</p>
  <p>Welcome aboard! 🎉<br>Your account has been successfully set up and is ready to use.</p>
  <p>If you have any questions or need help getting started, feel free to reach out! We're happy to help.</p>
  <p>Thanks for joining us,<br>The Team at Rabotka</p>`;

  return wrapEmailHtml(body);
}
