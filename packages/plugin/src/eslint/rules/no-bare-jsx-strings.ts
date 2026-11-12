import type { Rule } from 'eslint';
import ignore = require('ignore');
import { isAbsolute, relative, resolve } from 'node:path';

interface NoBareJsxStringsOptions {
  readonly ignorePatterns?: readonly string[];
  readonly ignoreTests?: boolean;
}

function ignoredFile(context: Rule.RuleContext): boolean {
  const options = (context.options[0] ?? {}) as NoBareJsxStringsOptions;
  const filename = context.filename.replaceAll('\\', '/');
  if (
    options.ignoreTests !== false &&
    /(?:^|\/)__tests__\/|\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(filename)
  )
    return true;
  if (!options.ignorePatterns?.length) return false;
  const path = relative(
    resolve(context.cwd),
    resolve(context.filename),
  ).replaceAll('\\', '/');
  // Do not turn unresolvable/outside-workspace paths into exemptions.
  if (!path || isAbsolute(path) || path === '..' || path.startsWith('../'))
    return false;
  return ignore()
    .add([...options.ignorePatterns])
    .ignores(path);
}

type LiteralNode = Rule.Node & { readonly value?: unknown };
type TemplateNode = Rule.Node & {
  readonly expressions?: readonly unknown[];
  readonly quasis?: ReadonlyArray<{
    readonly value?: { readonly cooked?: string };
  }>;
};
type ExpressionContainerNode = Rule.Node & {
  readonly expression?: Rule.Node;
};
type AttributeNode = Rule.Node & {
  readonly name?: { readonly name?: string };
  readonly value?: Rule.Node;
};

const userFacingAttributes = new Set([
  'alt',
  'aria-label',
  'placeholder',
  'title',
]);

function containsWords(value: unknown): value is string {
  return typeof value === 'string' && /[\p{L}\p{N}]/u.test(value);
}

function staticText(node: Rule.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'Literal') {
    const value = (node as LiteralNode).value;
    return typeof value === 'string' ? value : undefined;
  }
  if (node.type === 'TemplateLiteral') {
    const template = node as TemplateNode;
    if ((template.expressions?.length ?? 0) > 0) return undefined;
    return template.quasis?.map((quasi) => quasi.value?.cooked ?? '').join('');
  }
  return undefined;
}

export const noBareJsxStrings: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow inline user-facing JSX text; message catalogs and localization calls are application-owned.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          ignorePatterns: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            description:
              'Additional gitignore-style paths relative to the lint working directory, such as **/dev/** or **/*.stories.tsx.',
          },
          ignoreTests: {
            type: 'boolean',
            default: true,
            description:
              'Skip spec/test filenames and __tests__ directories; set false to check them too.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      bare: 'Move user-facing JSX string "{{text}}" to a message catalog or localization call. This rule checks inline literals, not translation completeness.',
    },
  },
  create(context) {
    if (ignoredFile(context)) return {};
    const report = (node: Rule.Node, value: string) => {
      context.report({
        node,
        messageId: 'bare',
        data: { text: value.trim().replace(/\s+/g, ' ') },
      });
    };
    return {
      JSXText(node: Rule.Node) {
        const value = (node as LiteralNode).value;
        if (containsWords(value)) report(node, value);
      },
      JSXExpressionContainer(node: Rule.Node) {
        const expression = (node as ExpressionContainerNode).expression;
        const value = staticText(expression);
        if (containsWords(value)) report(expression ?? node, value);
      },
      JSXAttribute(node: Rule.Node) {
        const attribute = node as AttributeNode;
        if (!userFacingAttributes.has(attribute.name?.name ?? '')) return;
        const value = staticText(attribute.value);
        if (containsWords(value)) report(attribute.value ?? node, value);
      },
    };
  },
};
