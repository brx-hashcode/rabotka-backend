# WhatsApp (Twilio)

WhatsApp messaging is implemented via **Twilio**. There is no Baileys or session storage in Redis for WhatsApp.

- **Sending**: OTP and verification links are sent using the Twilio API. Configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_WHATSAPP_FROM` in your environment.
- **Incoming**: Configure your Twilio WhatsApp number (or sandbox) to POST to `https://your-domain/api/v1/whatsapp/incoming`. The endpoint validates the request signature and forwards messages to the conversation handler.

Documentation:

- [Twilio WhatsApp API](https://www.twilio.com/docs/whatsapp)
- [Twilio WhatsApp Sandbox](https://www.twilio.com/docs/whatsapp/sandbox)
- [Webhook security (signature validation)](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
