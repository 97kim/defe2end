/** `{{KEY}}` in a step's url, selector, value or expected (spec 2.6). Keys follow the variable key rule. */
const VARIABLE_REF = /\{\{([A-Za-z0-9_]+)\}\}/g;

export type Substitution =
  | { ok: true; text: string; /** Secret values that went into `text`, for masking. */ secrets: string[] }
  | { ok: false; code: "missing_secret"; key: string };

/**
 * Replaces each `{{KEY}}` once. The result is not read as a template again, so a value containing
 * `{{OTHER}}` stays literal. An unknown key stays literal; a secret with an empty value fails the step.
 */
export function substituteVariables(text: string, variables: Record<string, { value: string; secret: boolean }>): Substitution {
  const secrets: string[] = [];
  let failure: Extract<Substitution, { ok: false }> | undefined;
  const result = text.replace(VARIABLE_REF, (match, key: string) => {
    const variable = Object.hasOwn(variables, key) ? variables[key] : undefined;
    if (!variable) return match;
    if (variable.secret) {
      if (variable.value === "") failure ??= { ok: false, code: "missing_secret", key };
      secrets.push(variable.value);
    }
    return variable.value;
  });
  return failure ?? { ok: true, text: result, secrets };
}
