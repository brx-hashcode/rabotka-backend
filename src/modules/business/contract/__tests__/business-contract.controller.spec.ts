import { attachment } from '../business-contract.controller';

describe('attachment', () => {
  it('gives an ASCII name, and the exact one for browsers that read filename*', () => {
    expect(attachment('contrat_Facturée_Femme.pdf')).toBe(
      `attachment; filename="contrat_Facturee_Femme.pdf"; filename*=UTF-8''contrat_Factur%C3%A9e_Femme.pdf`,
    );
  });
});
