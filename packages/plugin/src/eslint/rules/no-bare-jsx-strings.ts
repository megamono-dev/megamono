import type { Rule } from 'eslint';

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
      description: 'Require user-facing JSX strings to pass through t().',
    },
    schema: [],
    messages: {
      bare: 'User-facing JSX string "{{text}}" must pass through t().',
    },
  },
  create(context) {
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
