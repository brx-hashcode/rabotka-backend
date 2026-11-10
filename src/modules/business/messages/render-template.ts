/** What a template's placeholders stand for, for one candidate. */
export type TemplateVars = {
  prenom: string;
  poste: string;
  entreprise: string;
};

/** The placeholders a business may write, as the editor lists them. */
export const PLACEHOLDERS = ['{prenom}', '{poste}', '{entreprise}'] as const;

/**
 * A template's words for one candidate: `{prenom}`, `{poste}` and
 * `{entreprise}` filled in (any case, spaces allowed inside the braces);
 * anything else in braces is left as written.
 */
export function renderTemplate(body: string, vars: TemplateVars): string {
  return body.replace(
    /\{\s*(prenom|prénom|poste|entreprise)\s*\}/gi,
    (_, key: string) => {
      const k = key.toLowerCase().replace('é', 'e') as keyof TemplateVars;
      return vars[k]?.trim() || '';
    },
  );
}
