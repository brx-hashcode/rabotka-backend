import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MailerOptions } from '@nestjs-modules/mailer/dist/interfaces/mailer-options.interface';
import type { TemplateAdapter } from '@nestjs-modules/mailer/dist/interfaces/template-adapter.interface';
import Handlebars from 'handlebars';

// CJS-safe: mjml package exports the function as module.exports; .default is undefined at runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- required for correct CJS interop in worker
const mjmlModule = require('mjml');
const mjml = typeof mjmlModule === 'function' ? mjmlModule : mjmlModule.default;

const TEMPLATE_EXT = '.mjml';

export class MjmlHandlebarsAdapter implements TemplateAdapter {
  private readonly precompiledTemplates: Record<
    string,
    Handlebars.TemplateDelegate
  > = {};

  constructor(_config?: { inlineCssEnabled?: boolean }) {
    Handlebars.registerHelper('concat', (...args: unknown[]) => {
      args.pop();
      return args.join('');
    });
  }

  compile(
    mail: {
      data: {
        html?: string;
        template?: string;
        context?: Record<string, unknown>;
      };
    },
    callback: (err?: Error) => void,
    mailerOptions: MailerOptions,
  ): void {
    const templateDir = mailerOptions.template?.dir ?? '';
    const templateNameOrPath = mail.data.template ?? '';
    const templateBaseDir = templateDir;
    const templateName = path.basename(
      templateNameOrPath,
      path.extname(templateNameOrPath),
    );
    const templateDirResolved = path.isAbsolute(templateNameOrPath)
      ? path.dirname(templateNameOrPath)
      : path.join(templateBaseDir, path.dirname(templateNameOrPath));
    const templatePath = path.join(
      templateDirResolved,
      templateName + TEMPLATE_EXT,
    );
    const templateKey = path
      .relative(templateBaseDir, templatePath)
      .replace(TEMPLATE_EXT, '');

    if (!this.precompiledTemplates[templateKey]) {
      try {
        const source = fs.readFileSync(templatePath, 'utf-8');
        const hbsOptions = mailerOptions.template?.options ?? { strict: true };
        this.precompiledTemplates[templateKey] = Handlebars.compile(
          source,
          hbsOptions,
        );
      } catch (err) {
        return callback(err instanceof Error ? err : new Error(String(err)));
      }
    }

    try {
      const rendered = this.precompiledTemplates[templateKey](
        mail.data.context ?? {},
      );
      mail.data.html = mjml(rendered).html;
    } catch (err) {
      return callback(err instanceof Error ? err : new Error(String(err)));
    }
    callback();
  }
}
