
export interface WhatsAppTemplate<Args extends unknown[]> {
  contentSid: string;
  variables: (...args: Args) => Record<string, string>;
}

export const WHATSAPP_TEMPLATES = {
  otp: {
    contentSid: 'HXf66c3d91d9f56e59b72d8fad31d4a795',
    variables: (code: string) => ({ '1': code }),
  } satisfies WhatsAppTemplate<[code: string]>,
  kyc: {
    contentSid: 'HX58d0e132c50e52352a70e5aa8cdf8d5a',
    variables: (name: string) => ({ '1': name }),
  } satisfies WhatsAppTemplate<[name: string]>,
  accountActivatedWorker: {
    contentSid: 'HXef7bf2ce65d308deaa964faf1e3aaf04',
    variables: (firstName: string) => ({ '1': firstName }),
  } satisfies WhatsAppTemplate<[firstName: string]>,
  accountActivatedEmployer: {
    contentSid: 'HXf55fa9db88558fd5c27d1d2dd67c3f64',
    variables: (firstName: string) => ({ '1': firstName }),
  } satisfies WhatsAppTemplate<[firstName: string]>,
} as const;

export type WhatsAppTemplateName = keyof typeof WHATSAPP_TEMPLATES;
