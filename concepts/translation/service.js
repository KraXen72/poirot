const { TranslationRepository } = require('./repository');
const { LocaleService } = require('../locale/service');
const { getNestedValue } = require('../utils/json-utils');

/**
 * Service for processing translation calls and coordinating translation loading
 */
class TranslationService {
    constructor(translationRepository = new TranslationRepository(), localeService = new LocaleService()) {
        this.translationRepository = translationRepository;
        this.localeService = localeService;
    }

    /**
     * Find all m.methodName() and m["nested.key"]() calls in text
     * @param {string} text The source code text to analyze
     * @returns {Array} Array of translation call objects
     */
    findTranslationCalls(text) {
        const calls = [];
        
        // Pattern 1: m.methodName() or m.methodName(params) - original flat key syntax
        const flatPattern = /\bm\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(\s*([^)]*)\s*\)/g;
        
        // Pattern 2: m["nested.key"]() or m['nested.key']() - new nested key syntax
        const nestedPattern = /\bm\[(['"`])([^'"]+)\1\]\s*\(\s*([^)]*)\s*\)/g;
        
        let match;
        
        // Find flat key patterns
        while ((match = flatPattern.exec(text)) !== null) {
            calls.push({
                methodName: match[1],
                params: match[2].trim(),
                start: match.index,
                end: match.index + match[0].length,
                keyType: 'flat'
            });
        }
        
        // Find nested key patterns
        while ((match = nestedPattern.exec(text)) !== null) {
            calls.push({
                methodName: match[2], // The key inside the quotes
                params: match[3].trim(),
                start: match.index,
                end: match.index + match[0].length,
                keyType: 'nested'
            });
        }
        
        // Sort by position to maintain order
        calls.sort((a, b) => a.start - b.start);
        
        return calls;
    }

    /**
     * Load translations for a workspace and locale
     * @param {string} workspacePath The workspace root path
     * @param {string} locale The locale to load translations for
     * @returns {Promise<Object|null>} The translations object or null if not found
     */
    async loadTranslationsForLocale(workspacePath, locale) {
        const translationPath = await this.localeService.resolveTranslationPathAsync(workspacePath, locale);
        return await this.translationRepository.loadTranslations(translationPath, locale);
    }

    /**
     * Process paraglide variant array to extract display value
     * @param {Array} variantArray The paraglide variant array
     * @returns {string|null} The first match value from the variant or null if invalid
     */
    processParaglideVariant(variantArray) {
        try {
            if (!Array.isArray(variantArray) || variantArray.length === 0) {
                return null;
            }

            const firstVariant = variantArray[0];
            
            if (!firstVariant || typeof firstVariant !== 'object' || !firstVariant.match) {
                return null;
            }

            const matchValues = Object.values(firstVariant.match);
            if (matchValues.length === 0) {
                return null;
            }

            return matchValues[0];
        } catch (error) {
            console.error('Error processing paraglide variant:', error);
            return null;
        }
    }

    /**
     * Get translation value for a specific key (supports nested dot notation)
     * @param {Object} translations The translations object
     * @param {string} key The translation key (can be nested like "login.inputs.email")
     * @returns {string|null} The translation value or null if not found
     */
    getTranslation(translations, key) {
        if (!translations) {
            return null;
        }

        let value;
        
        if (key.includes('.')) {
            value = getNestedValue(translations, key.split('.'));
        } else {
            value = translations[key];
        }
        
        if (value === undefined || value === null) {
            return null;
        }

        if (typeof value === 'string') {
            return value;
        }

        if (Array.isArray(value)) {
            const variantValue = this.processParaglideVariant(value);
            if (variantValue) {
                return `${variantValue}*`;
            }
        }

        return null;
    }

    /**
     * Search for a translation key across all available locales
     * @param {string} workspacePath The workspace root path
     * @param {string} key The translation key to search for
     * @param {string} currentLocale The current locale to exclude from search
     * @returns {Promise<Object|null>} Object with {translation, locale} if found, null otherwise
     */
    async searchKeyInAllLocales(workspacePath, key, currentLocale) {
        try {
            const availableLocales = await this.localeService.getAvailableLocales(workspacePath);
            
            for (const locale of availableLocales) {
                if (locale === currentLocale) continue;
                
                const translations = await this.loadTranslationsForLocale(workspacePath, locale);
                if (translations) {
                    const translationValue = this.getTranslation(translations, key);
                    if (translationValue) {
                        return {
                            translation: translationValue,
                            locale: locale
                        };
                    }
                }
            }
            
            return null;
        } catch (error) {
            console.error('Error searching key in all locales:', error);
            return null;
        }
    }

    /**
     * Process translation calls and return their resolved values with warning states
     * @param {Array} translationCalls Array of translation call objects
     * @param {Object} translations The translations object for current locale
     * @param {string} workspacePath The workspace root path
     * @param {string} currentLocale The current locale
     * @returns {Promise<Array>} Array of objects with call info, translation values, and warning states
     */
    async processTranslationCallsWithWarnings(translationCalls, translations, workspacePath, currentLocale) {
        const results = [];
        
        for (const call of translationCalls) {
            const currentTranslation = this.getTranslation(translations, call.methodName);
            
            if (currentTranslation) {
                results.push({
                    ...call,
                    translationValue: currentTranslation,
                    warningType: null
                });
            } else {
                const searchResult = await this.searchKeyInAllLocales(workspacePath, call.methodName, currentLocale);
                
                if (searchResult) {
                    results.push({
                        ...call,
                        translationValue: searchResult.translation,
                        warningType: 'missingLocale',
                        foundInLocale: searchResult.locale
                    });
                } else {
                    results.push({
                        ...call,
                        translationValue: null,
                        warningType: 'noLocale'
                    });
                }
            }
        }
        
        return results;
    }

    /**
     * Process translation calls and return their resolved values
     * @param {Array} translationCalls Array of translation call objects
     * @param {Object} translations The translations object
     * @returns {Array} Array of objects with call info and translation values
     */
    processTranslationCalls(translationCalls, translations) {
        const results = [];
        
        for (const call of translationCalls) {
            const translationValue = this.getTranslation(translations, call.methodName);
            if (translationValue) {
                results.push({
                    ...call,
                    translationValue
                });
            }
        }
        
        return results;
    }
}

module.exports = { TranslationService };