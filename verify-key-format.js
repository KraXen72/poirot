const fs = require('fs');
const { formatKeyCall } = require('./concepts/utils/key-format.js');

// Print the VALID_IDENTIFIER regex literal from the source file
const file = fs.readFileSync('./concepts/utils/key-format.js', 'utf8');
const match = file.match(/const\s+VALID_IDENTIFIER\s*=\s*(\/[^;]+);/);
console.log(match ? match[1] : 'VALID_IDENTIFIER not found in file');

const cases = [
    // Should use dot notation (valid identifiers)
    ['foo',       null,       'm.foo()'],
    ['_private',  null,       'm._private()'],
    ['$el',       null,       'm.$el()'],
    ['foo123',    null,       'm.foo123()'],
    // Should use bracket notation (invalid identifiers)
    ['foo.bar',   null,       'm["foo.bar"]()'],
    ['my-key',    null,       'm["my-key"]()'],
    ['my key',    null,       'm["my key"]()'],
    ['123abc',    null,       'm["123abc"]()'],
    ['user@mail', null,       'm["user@mail"]()'],
    // Injection safety
    ['fo"o',      null,       'm["fo\\"o"]()'],
    // Template wrapping
    ['foo.bar',   'template', '{m["foo.bar"]()}'],
    ['foo',       'template', '{m.foo()}'],
];

let passed = 0;
let failed = 0;
for (const [key, interp, expected] of cases) {
    let result;
    try {
        result = formatKeyCall(key, interp);
    } catch (err) {
        result = `THREW: ${err.message}`;
    }
    if (result === expected) {
        console.log(`✅ formatKeyCall(${JSON.stringify(key)}, ${JSON.stringify(interp)}) => ${result}`);
        passed++;
    } else {
        console.error(`❌ formatKeyCall(${JSON.stringify(key)}, ${JSON.stringify(interp)})`);
        console.error(`   expected:  ${expected}`);
        console.error(`   got:       ${result}`);
        failed++;
    }
}
console.log(`\n${passed} passed, ${failed} failed`);
