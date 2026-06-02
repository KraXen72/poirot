const wordlists = require('./human-key-wordlists.json');

function randomItem(items) {
    return items[Math.floor(Math.random() * items.length)];
}

function randomAdjectivePair() {
    const firstWords = Math.random() < wordlists.colors.length / (wordlists.colors.length + wordlists.adjectives.length)
        ? wordlists.colors
        : wordlists.adjectives;
    const first = randomItem(firstWords);
    let second = randomItem(wordlists.adjectives);

    while (second === first && wordlists.adjectives.length > 1) {
        second = randomItem(wordlists.adjectives);
    }

    return [first, second];
}

function generateHumanKey() {
    const [first, second] = randomAdjectivePair();
    return [
        first,
        second,
        randomItem(wordlists.nouns),
        randomItem(wordlists.verbs),
    ].join('_');
}

module.exports = { generateHumanKey };
