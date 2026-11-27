import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { globSync } from 'glob';
import * as ts from 'typescript';

/**
 * A SUSPENDED or BANNED business makes no write: `BusinessProfileGuard`
 * refuses it, except on a route marked `@OpenToBlockedBusiness()`. Opening
 * one more route is a decision, so it changes this list: a reviewer sees it.
 */
const OPEN_TO_BLOCKED_BUSINESS = [
  'modules/business/business.controller.ts:BusinessController.uploadDocument',
  'modules/business/cv-screening/cv-removal.controller.ts:CvRemovalController',
  'modules/business/linkedin/linkedin.controller.ts:LinkedinController.disconnect',
  'modules/business/mailbox/mailbox.controller.ts:MailboxController.disconnect',
  'modules/business/team/team.controller.ts:TeamController.remove',
];

const SRC = path.join(__dirname, '..', '..', '..');

function decoratorNames(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : [];
  for (const d of decorators ?? []) {
    const expr = d.expression;
    const callee = ts.isCallExpression(expr) ? expr.expression : expr;
    if (ts.isIdentifier(callee)) names.add(callee.text);
  }
  return names;
}

/** `file:Class` or `file:Class.method` for every use of the decorator. */
function openRoutes(): string[] {
  const found: string[] = [];
  for (const file of globSync('**/*.controller.ts', {
    cwd: SRC,
    ignore: ['**/__tests__/**'],
  })) {
    const source = ts.createSourceFile(
      file,
      readFileSync(path.join(SRC, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node)) return;
      const name = `${file}:${node.name?.text ?? '?'}`;
      if (decoratorNames(node).has('OpenToBlockedBusiness')) found.push(name);
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) &&
          decoratorNames(member).has('OpenToBlockedBusiness')
        ) {
          found.push(`${name}.${member.name.getText(source)}`);
        }
      }
    });
  }
  return found.sort();
}

describe('route contract: writes open to a blocked business', () => {
  it('are exactly the reviewed list', () => {
    expect(openRoutes()).toEqual([...OPEN_TO_BLOCKED_BUSINESS].sort());
  });
});
