type TranslationObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is TranslationObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Get a nested value from a translation object using dot notation.
 */
export function getNestedValue(obj: TranslationObject, keyPath: string): unknown {
  if (!keyPath.includes('.')) {
    return obj[keyPath];
  }

  return keyPath.split('.').reduce((current: unknown, key: string) => {
    if (isPlainObject(current) && key in current) {
      return current[key];
    }
    return undefined;
  }, obj);
}

/**
 * Set a nested value in a translation object using dot notation.
 */
export function setNestedValue(obj: TranslationObject, keyPath: string, value: unknown): void {
  if (!keyPath.includes('.')) {
    obj[keyPath] = value;
    return;
  }

  const keys = keyPath.split('.');
  const lastKey = keys.pop();
  if (!lastKey) {
    return;
  }

  let current = obj;
  for (const key of keys) {
    const currentValue = current[key];
    if (!isPlainObject(currentValue)) {
      current[key] = {};
    }
    current = current[key] as TranslationObject;
  }

  current[lastKey] = value;
}

/**
 * Delete a nested value from a translation object using dot notation.
 * Returns true when the path existed and was deleted.
 */
export function deleteNestedValue(obj: TranslationObject, keyPath: string): boolean {
  if (!keyPath.includes('.')) {
    if (!(keyPath in obj)) {
      return false;
    }

    delete obj[keyPath];
    return true;
  }

  const keys = keyPath.split('.');
  const lastKey = keys.pop();
  if (!lastKey) {
    return false;
  }

  let current: unknown = obj;
  const parentChain: Array<{ container: TranslationObject; key: string }> = [];

  for (const key of keys) {
    if (!isPlainObject(current) || !(key in current)) {
      return false;
    }

    parentChain.push({ container: current, key });
    current = current[key];
  }

  if (!isPlainObject(current) || !(lastKey in current)) {
    return false;
  }

  delete current[lastKey];

  for (let i = parentChain.length - 1; i >= 0; i--) {
    const { container, key } = parentChain[i];
    const child = container[key];
    if (isPlainObject(child) && Object.keys(child).length === 0) {
      delete container[key];
      continue;
    }
    break;
  }

  return true;
}

/**
 * Validate a translation key for rename operations.
 */
export function isValidTranslationKey(key: string): boolean {
  if (!key) {
    return false;
  }

  if (key.trim() !== key) {
    return false;
  }

  if (/[\s"'`]/.test(key)) {
    return false;
  }

  const segments = key.split('.');
  return segments.every((segment) => segment.length > 0);
}

/**
 * Check if a key can use dot notation (m.some_key()).
 */
export function isIdentifierKey(key: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key);
}

function escapeDoubleQuotedKey(key: string): string {
  return key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build the accessor part of a Paraglide call for a key.
 */
export function formatTranslationAccessor(key: string): string {
  if (isIdentifierKey(key)) {
    return `m.${key}`;
  }

  return `m["${escapeDoubleQuotedKey(key)}"]`;
}

/**
 * Build a full Paraglide call string for a key.
 */
export function formatTranslationCall(key: string, interpolationType: 'template' | 'code'): string {
  const keyCall = `${formatTranslationAccessor(key)}()`;
  return interpolationType === 'template' ? `{${keyCall}}` : keyCall;
}
