function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function getNestedValue(obj, segments) {
    return segments.reduce((current, segment) => {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return undefined;
        }

        return current[segment];
    }, obj);
}

function setNestedValue(obj, segments, value) {
    if (segments.length === 0) {
        return value;
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

function detectIndent(raw) {
    const match = raw.match(/^[\t ]+/m);
    if (!match) {
        return 2;
    }

    return match[0].startsWith('\t') ? '\t' : match[0].length;
}

function stringifyJsonLike(raw, json) {
    return JSON.stringify(json, null, detectIndent(raw)) + (raw.endsWith('\n') ? '\n' : '');
}

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
    renameJsonKey,
    detectIndent,
    stringifyJsonLike,
    findKeyLine,
};
