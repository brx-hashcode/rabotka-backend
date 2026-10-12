import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { globSync } from 'glob';
import * as ts from 'typescript';

/**
 * Every HTTP route is either guarded or DECLARED public.
 *
 * This app registers no global auth guard: each controller brings its own. So
 * a route that forgets `@UseGuards` is not refused — it is open to anyone, and
 * nothing fails. It has happened (see admin-routes.contract.spec.ts). This
 * test turns that silence into a failure: a route must carry a guard, on its
 * class or on itself, or say `@Public()` — which makes "this is open on
 * purpose" a line someone wrote and a reviewer sees.
 *
 * Parsed with the TypeScript compiler, not regex: decorators span lines,
 * files hold several classes, and a DTO class before a controller fooled the
 * regex version of this check during the security audit.
 */

const SRC = path.join(__dirname, '..', '..', '..');
const HTTP_METHODS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All']);

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

/** `file:Class.method` for every route with neither a guard nor @Public(). */
function unguardedRoutes(): string[] {
  const files = globSync('**/*.controller.ts', {
    cwd: SRC,
    ignore: ['**/__tests__/**'],
  });
  const found: string[] = [];

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(path.join(SRC, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );

    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node)) return;
      const classDecorators = decoratorNames(node);
      if (!classDecorators.has('Controller')) return;

      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const own = decoratorNames(member);
        if (![...own].some((n) => HTTP_METHODS.has(n))) continue;

        const guarded =
          classDecorators.has('UseGuards') || own.has('UseGuards');
        const declaredPublic =
          classDecorators.has('Public') || own.has('Public');
        if (!guarded && !declaredPublic) {
          found.push(
            `${file}:${node.name?.text ?? '?'}.${member.name.getText(source)}`,
          );
        }
      }
    });
  }
  return found.sort();
}

describe('route contract: guarded or declared public', () => {
  it('finds the controllers at all', () => {
    // Guards the guard: a glob that matches nothing would pass vacuously.
    expect(globSync('**/*.controller.ts', { cwd: SRC }).length).toBeGreaterThan(
      30,
    );
  });

  it('leaves no route open by omission', () => {
    expect(unguardedRoutes()).toEqual([]);
  });
});
