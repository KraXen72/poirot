function formatKeyCall(key, interpolationType) {
    const isTemplate = interpolationType === 'template';
    const keyCall = key.includes('.') ? `m["${key}"]()` : `m.${key}()`;
    return isTemplate ? `{${keyCall}}` : keyCall;
}

module.exports = { formatKeyCall };
