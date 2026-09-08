/** Extract the generator's survey, not an arbitrary JSON diagnostic from Nx. */
export function surveyOutput(stdout: string): {
  json: string;
  diagnostics: string;
} {
  const matches: { start: number; end: number; value: unknown }[] = [];
  for (const candidate of stdout.matchAll(/^\s*\{/gm)) {
    const start = candidate.index + candidate[0].lastIndexOf('{');
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < stdout.length; end++) {
      const character = stdout[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        try {
          const value = JSON.parse(stdout.slice(start, end + 1));
          if (
            value.schemaVersion === 1 &&
            value.baseline &&
            Array.isArray(value.projects) &&
            value.inventory &&
            Array.isArray(value.recommendations)
          )
            matches.push({ start, end: end + 1, value });
        } catch {
          // Ordinary Nx diagnostics can contain braces; they are not surveys.
        }
        break;
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected one Megamono survey JSON object; received ${matches.length}.`,
    );
  }
  const match = matches[0];
  return {
    json: JSON.stringify(match.value, null, 2),
    diagnostics: (
      stdout.slice(0, match.start) + stdout.slice(match.end)
    ).trim(),
  };
}
