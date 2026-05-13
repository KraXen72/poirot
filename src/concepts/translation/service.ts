import { TranslationRepository } from './repository';
import { LocaleService } from '../locale/service';
import { ProjectService } from '../project/service';
import { getNestedValue } from './key-utils';

type TranslationCall = {
  methodName: string;
  params: string;
  start: number;
  end: number;
  keyStart: number;
  keyEnd: number;
  accessorEnd: number;
  keyType: 'flat' | 'nested';
};

type TranslationResult = TranslationCall & {
  translationValue: string | null;
  warningType?: 'missingLocale' | 'noLocale' | null;
  foundInLocale?: string;
};

type ParaglideVariant = {
  match?: Record<string, string>;
};

/**
 * Service for processing translation calls and coordinating translation loading
 */
export class TranslationService {
  private translationRepository: TranslationRepository;
  private localeService: LocaleService;
  private projectService: ProjectService;

  constructor() {
    this.translationRepository = new TranslationRepository();
    this.localeService = new LocaleService();
    this.projectService = new ProjectService();
  }

  /**
   * Find all m.methodName() and m["nested.key"]() calls in text
   * @param text The source code text to analyze
   * @returns Array of translation call objects
   */
  findTranslationCalls(text: string): TranslationCall[] {
    const calls: TranslationCall[] = [];

    // Pattern 1: m.methodName() or m.methodName(params) - original flat key syntax
    const flatPattern = /\bm\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(\s*([^)]*)\s*\)/g;

    // Pattern 2: m["nested.key"]() or m['nested.key']() - new nested key syntax
    const nestedPattern = /\bm\[(['"`])([^'"]+)\1\]\s*\(\s*([^)]*)\s*\)/g;

    let match: RegExpExecArray | null;

    // Find flat key patterns
    while ((match = flatPattern.exec(text)) !== null) {
      const keyStart = match.index + match[0].indexOf(match[1]);
      const keyEnd = keyStart + match[1].length;
      const accessorEnd = match.index + match[0].indexOf('(');

      calls.push({
        methodName: match[1],
        params: match[2].trim(),
        start: match.index,
        end: match.index + match[0].length,
        keyStart,
        keyEnd,
        accessorEnd,
        keyType: 'flat',
      });
    }

    // Find nested key patterns
    while ((match = nestedPattern.exec(text)) !== null) {
      const keyStart = match.index + match[0].indexOf(match[2]);
      const keyEnd = keyStart + match[2].length;
      const accessorEnd = match.index + match[0].indexOf('(');

      calls.push({
        methodName: match[2], // The key inside the quotes
        params: match[3].trim(),
        start: match.index,
        end: match.index + match[0].length,
        keyStart,
        keyEnd,
        accessorEnd,
        keyType: 'nested',
      });
    }

    // Sort by position to maintain order
    calls.sort((a, b) => a.start - b.start);

    return calls;
  }

  /**
   * Load translations for a workspace and locale
   * @param workspacePath The workspace root path
   * @param locale The locale to load translations for
   * @returns The translations object or null if not found
   */
  async loadTranslationsForLocale(
    workspacePath: string,
    locale: string
  ): Promise<Record<string, unknown> | null> {
    const translationPath = this.localeService.resolveTranslationPath(workspacePath, locale);
    return await this.translationRepository.loadTranslations(translationPath, locale);
  }

  /**
   * Process paraglide variant array to extract display value
   * @param variantArray The paraglide variant array
   * @returns The first match value from the variant or null if invalid
   */
  processParaglideVariant(variantArray: unknown): string | null {
    try {
      // Get the first element of the array
      if (!Array.isArray(variantArray) || variantArray.length === 0) {
        return null;
      }

      const firstVariant = variantArray[0] as ParaglideVariant;

      // Check if it has the expected structure with a match property
      if (!firstVariant || typeof firstVariant !== 'object' || !firstVariant.match) {
        return null;
      }

      // Get the first value from the match object
      const matchValues = Object.values(firstVariant.match);
      if (matchValues.length === 0) {
        return null;
      }

      // Return the first match value
      return String(matchValues[0]);
    } catch (error) {
      console.error('Error processing paraglide variant:', error);
      return null;
    }
  }

  /**
   * Get translation value for a specific key (supports nested dot notation)
   * @param translations The translations object
   * @param key The translation key (can be nested like "login.inputs.email")
   * @returns The translation value or null if not found
   */
  getTranslation(translations: Record<string, unknown>, key: string): string | null {
    if (!translations) {
      return null;
    }

    let value: unknown;

    // Try nested key lookup first (e.g., "login.inputs.email")
    if (key.includes('.')) {
      value = getNestedValue(translations, key);
    } else {
      // Fallback to flat key lookup for backward compatibility
      value = translations[key];
    }

    if (value === undefined || value === null) {
      return null;
    }

    // Case 1: Simple string value - return as-is
    if (typeof value === 'string') {
      return value;
    }

    // Case 2: Paraglide variant array - process and add asterisk
    if (Array.isArray(value)) {
      const variantValue = this.processParaglideVariant(value);
      if (variantValue) {
        return `${variantValue}*`;
      }
    }

    // Case 3: Unsupported format
    return null;
  }

  /**
   * Search for a translation key across all available locales
   * @param workspacePath The workspace root path
   * @param key The translation key to search for
   * @param currentLocale The current locale to exclude from search
   * @returns Object with {translation, locale} if found, null otherwise
   */
  async searchKeyInAllLocales(
    workspacePath: string,
    key: string,
    currentLocale: string
  ): Promise<{ translation: string; locale: string } | null> {
    try {
      const inlangSettings = this.localeService.loadInlangSettings(workspacePath);
      const availableLocales = inlangSettings?.locales || ['en'];

      // Search through all locales except the current one
      for (const locale of availableLocales) {
        if (locale === currentLocale) continue;

        const translations = await this.loadTranslationsForLocale(workspacePath, locale);
        if (translations) {
          const translationValue = this.getTranslation(translations, key);
          if (translationValue) {
            return {
              translation: translationValue,
              locale: locale,
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
   * @param translationCalls Array of translation call objects
   * @param translations The translations object for current locale
   * @param workspacePath The workspace root path
   * @param currentLocale The current locale
   * @returns Array of objects with call info, translation values, and warning states
   */
  async processTranslationCallsWithWarnings(
    translationCalls: TranslationCall[],
    translations: Record<string, unknown>,
    workspacePath: string,
    currentLocale: string
  ): Promise<TranslationResult[]> {
    const results: TranslationResult[] = [];

    for (const call of translationCalls) {
      const currentTranslation = this.getTranslation(translations, call.methodName);

      if (currentTranslation) {
        // Translation found in current locale - normal case
        results.push({
          ...call,
          translationValue: currentTranslation,
          warningType: null,
        });
      } else {
        // Translation missing in current locale - search other locales
        const searchResult = await this.searchKeyInAllLocales(
          workspacePath,
          call.methodName,
          currentLocale
        );

        if (searchResult) {
          // Found in other locale(s) - show yellow warning
          results.push({
            ...call,
            translationValue: searchResult.translation,
            warningType: 'missingLocale',
            foundInLocale: searchResult.locale,
          });
        } else {
          // Not found in any locale - show red error
          results.push({
            ...call,
            translationValue: null,
            warningType: 'noLocale',
          });
        }
      }
    }

    return results;
  }

  /**
   * Process translation calls and return their resolved values
   * @param translationCalls Array of translation call objects
   * @param translations The translations object
   * @returns Array of objects with call info and translation values
   */
  processTranslationCalls(
    translationCalls: TranslationCall[],
    translations: Record<string, unknown>
  ): TranslationResult[] {
    const results: TranslationResult[] = [];

    for (const call of translationCalls) {
      const translationValue = this.getTranslation(translations, call.methodName);
      if (translationValue) {
        results.push({
          ...call,
          translationValue,
        });
      }
    }

    return results;
  }
}
