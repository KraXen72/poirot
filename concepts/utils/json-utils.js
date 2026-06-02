/**
 * Creates a deep clone of the given value.
 * Uses the native `structuredClone` function if available, otherwise falls back to a JSON-based method.
 * Note: The JSON fallback does not preserve functions, `undefined`, `Symbol`, or circular references.
 *
 * @param {*} value - The value to deep clone.
 * @returns {*} A deep clone of the input value.
 */
function deepClone(value) {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

/**
 * Retrieves a value from a nested object based on an array of property segments.
 * Traversal stops and returns `undefined` if an intermediate value is not a non-array object.
 *
 * @param {Object} obj - The object to traverse.
 * @param {string[]} segments - An array of property names representing the path.
 * @returns {*} The value at the nested path, or `undefined` if the path does not exist.
 */
function getNestedValue(obj, segments) {
    return segments.reduce((current, segment) => {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return undefined;
        }

        return current[segment];
    }, obj);
}

/**
 * Sets a value at a nested path within an object, creating intermediate empty objects as needed.
 * If an intermediate segment exists but is not a non-array object (e.g., a primitive or an array), it is overwritten with an empty object.
 * Mutates the original object.
 *
 * @param {Object} obj - The target object to modify.
 * @param {string[]} segments - An array of property names representing the path. Must not be empty.
 * @param {*} value - The value to set at the target path.
 * @returns {Object} The original modified object.
 * @throws {Error} If the `segments` array is empty.
 */
function setNestedValue(obj, segments, value) {
    if (segments.length === 0) {
        throw new Error('setNestedValue: segments must not be empty');
    }

    let current = obj;
    for (let index = 0; index < segments.length - 1; index++) {
        const segment = segments[index];
        if (current[segment] === undefined || typeof current[segment] !== 'object' || Array.isArray(current[segment])) {
            current[segment] = {};
        }

        current = current[segment];
    }

    current[segments[segments.length - 1]] = value;
    return obj;
}

/**
 * Deletes a property at a nested path within an object.
 * Does nothing if the path does not resolve to a non-array object parent.
 * Mutates the original object.
 *
 * @param {Object} obj - The target object to modify.
 * @param {string[]} segments - An array of property names representing the path. Can be empty, in which case the function does nothing.
 * @returns {void}
 */
function deleteNestedValue(obj, segments) {
    if (segments.length === 0) {
        return;
    }

    const parentSegments = segments.slice(0, -1);
    const parent = parentSegments.length === 0 ? obj : getNestedValue(obj, parentSegments);

    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) {
        return;
    }

    delete parent[segments[segments.length - 1]];
}

/**
 * Renames a key within a deeply nested object. Performs the operation immutably by deep cloning the object first.
 * The old and new keys are specified as dot-separated path strings.
 * If the old key does not exist, or is the same as the new key, the original object is returned unmodified.
 *
 * @param {Object} obj - The source object.
 * @param {string} oldKey - The dot-separated path of the property to rename (e.g., "a.b.c").
 * @param {string} newKey - The dot-separated path of the destination (e.g., "x.y.z").
 * @returns {Object} A new object with the key renamed, or the original object if the old path has no value.
 */
function renameJsonKey(obj, oldKey, newKey) {
    if (oldKey === newKey) {
        return obj;
    }

    const oldSegments = oldKey.split('.');
    const newSegments = newKey.split('.');
    const value = getNestedValue(obj, oldSegments);

    if (value === undefined) {
        return obj;
    }

    const clone = deepClone(obj);
    deleteNestedValue(clone, oldSegments);
    setNestedValue(clone, newSegments, value);
    return clone;
}

/**
 * Deletes a key from a cloned JSON object.
 *
 * @param {Object} obj - The source object.
 * @param {string} key - The dot-separated key path to delete.
 * @returns {Object} A new object with the key deleted.
 */
function deleteJsonKey(obj, key) {
    const clone = deepClone(obj);
    deleteNestedValue(clone, key.split('.'));
    return clone;
}

/**
 * Flattens all leaf keys from a locale JSON object.
 *
 * @param {Object} obj
 * @param {string} prefix
 * @returns {string[]}
 */
function flattenJsonKeys(obj, prefix = '') {
    const keys = [];

    for (const [key, value] of Object.entries(obj || {})) {
        const currentKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            keys.push(...flattenJsonKeys(value, currentKey));
        } else {
            keys.push(currentKey);
        }
    }

    return keys;
}

/**
 * Detects the indentation character and count from a raw string.
 * It looks for the first line with leading whitespace (tabs or spaces).
 *
 * @param {string} raw - The raw string to analyze.
 * @returns {string|number} The indentation string if it's a tab ("\t"), or the number of spaces used for indentation. Defaults to `2` if no indentation is found.
 */
function detectIndent(raw) {
    const match = raw.match(/^[\t ]+/m);
    if (!match) {
        return 2;
    }

    return match[0].startsWith('\t') ? '\t' : match[0].length;
}

/**
 * Converts a JavaScript value to a JSON string with formatting that matches the indentation style of an existing raw string.
 * Also appends a trailing newline if the original raw string had one.
 *
 * @param {string} raw - The original string used to detect indentation and trailing newline preference.
 * @param {*} json - The value to stringify.
 * @returns {string} The formatted JSON string.
 */
function stringifyJsonLike(raw, json) {
    return JSON.stringify(json, null, detectIndent(raw)) + (raw.endsWith('\n') ? '\n' : '');
}

/**
 * Finds the 0-based line number within a JSON text string where a given key path is located.
 * The key path is specified as a dot-separated string.
 *
 * @param {string} text - The JSON text to search.
 * @param {string} keyPath - The dot-separated path of the key to locate (e.g., "a.b.c").
 * @returns {number|null} The 0-based line number where the key is found, or `null` if the path is not found.
 */
function findKeyLine(text, keyPath) {
    const segments = keyPath.split('.');
    let cursor = 0;

    for (const segment of segments) {
        const pattern = new RegExp(`"${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`, 'g');
        pattern.lastIndex = cursor;
        const match = pattern.exec(text);
        if (!match) {
            return null;
        }

        cursor = match.index + match[0].length;
    }

    const line = text.slice(0, cursor).split('\n').length - 1;
    return line;
}

module.exports = {
    deepClone,
    getNestedValue,
    setNestedValue,
    deleteNestedValue,
    deleteJsonKey,
    flattenJsonKeys,
    renameJsonKey,
    detectIndent,
    stringifyJsonLike,
    findKeyLine,
};
