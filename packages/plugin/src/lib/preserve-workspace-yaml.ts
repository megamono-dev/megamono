import type { Tree } from '@nx/devkit';
import { isMap, isSeq, parseDocument, type Node } from 'yaml';
import { isDeepStrictEqual } from 'node:util';

const path = 'pnpm-workspace.yaml';

/** Replay semantic generator changes onto the original comment-bearing YAML. */
export function preserveWorkspaceYaml(tree: Tree): () => void {
  const original = tree.read(path, 'utf8');
  if (original === null) return () => undefined;
  const document = parseDocument(original);
  if (document.errors.length || !isMap(document.contents)) {
    throw new Error(
      'Cannot safely edit pnpm-workspace.yaml: expected a valid YAML mapping.',
    );
  }
  const before = document.toJS();
  return () => {
    const current = tree.read(path, 'utf8');
    if (current === null)
      throw new Error(
        'A composed generator unexpectedly removed pnpm-workspace.yaml.',
      );
    const generated = parseDocument(current);
    if (generated.errors.length || !isMap(generated.contents)) {
      throw new Error(
        'A composed generator produced invalid pnpm-workspace.yaml.',
      );
    }
    const after = generated.toJS();
    if (isDeepStrictEqual(before, after)) {
      tree.write(path, original);
      return;
    }
    const merge = (
      node: Node | undefined,
      oldValue: unknown,
      newValue: unknown,
    ): Node => {
      if (node && isDeepStrictEqual(oldValue, newValue)) return node;
      if (isMap(node) && record(oldValue) && record(newValue)) {
        for (const key of Object.keys(oldValue))
          if (!(key in newValue)) node.delete(key);
        for (const [key, value] of Object.entries(newValue)) {
          node.set(
            key,
            merge(
              node.get(key, true) as Node | undefined,
              oldValue[key],
              value,
            ),
          );
        }
        return node;
      }
      if (isSeq(node) && Array.isArray(oldValue) && Array.isArray(newValue)) {
        const available = oldValue.map((value, index) => ({
          value,
          node: node.items[index],
          used: false,
        }));
        node.items = newValue.map((value) => {
          const match = available.find(
            (item) => !item.used && isDeepStrictEqual(item.value, value),
          );
          if (match) {
            match.used = true;
            return match.node;
          }
          return document.createNode(value);
        });
        return node;
      }
      const replacement = document.createNode(newValue);
      if (node) {
        replacement.comment = node.comment;
        replacement.commentBefore = node.commentBefore;
        replacement.spaceBefore = node.spaceBefore;
      }
      return replacement;
    };
    document.contents = merge(
      document.contents ?? undefined,
      before,
      after,
    ) as typeof document.contents;
    const result = document.toString();
    // Aliases or unusual node shapes must not silently alter generator intent.
    if (!isDeepStrictEqual(parseDocument(result).toJS(), after))
      throw new Error(
        'Cannot preserve pnpm-workspace.yaml without changing its meaning.',
      );
    tree.write(path, result);
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
