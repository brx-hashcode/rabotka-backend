import { templateReply } from './whatsapp-carousel';


export const LISTPICKER_WALLET_SID = 'HXc39e837cb45672990f826134f04b18ac';

export const CONTACT_INFO_SID = 'HXece187e3b80f4413d723d2214adc7a08';

export function walletRechargeReply(balanceLabel: string): string {
  return templateReply(LISTPICKER_WALLET_SID, { '1': balanceLabel });
}


export function contactReply(
  phone: string,
  email: string,
  address: string,
): string {
  return templateReply(CONTACT_INFO_SID, {
    '1': phone,
    '2': email,
    '3': address,
  });
}
