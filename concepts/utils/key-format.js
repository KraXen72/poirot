const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/**
 * Format key call based on key type and interpolation preference
 * @param {string} key The translation key
 * @param {string} interpolationType 'template' or 'code'
 * @returns {string} The formatted key call
 */
function formatKeyCall(key, interpolationType) {
    if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('formatKeyCall: key must be a non-empty string');
    }
    const isTemplate = interpolationType === 'template';
    const escapedKey = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const keyCall = VALID_IDENTIFIER.test(key) ? `m.${key}()` : `m["${escapedKey}"]()`;
    return isTemplate ? `{${keyCall}}` : keyCall;
}

module.exports = { formatKeyCall };
