const vscode = require('vscode');
const fsPromises = require('fs/promises');
const path = require('path');

/**
 * Service for managing locale configuration and inlang project settings
 */
class LocaleService {
    /**
     * Get the current locale from various sources in priority order
     */
    async getCurrentLocale() {
        // 1. Check VS Code configuration
        const config = vscode.workspace.getConfiguration('elementaryWatson');
        const configLocale = config.get('defaultLocale');
        if (configLocale) {
            return configLocale;
        }

        // 2. Check inlang settings if we have a workspace
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const inlangSettings = await this.loadInlangSettingsAsync(vscode.workspace.workspaceFolders[0].uri.fsPath);
            if (inlangSettings && inlangSettings.baseLocale) {
                return inlangSettings.baseLocale;
            }
        }

        // 3. Default to English
        return 'en';
    }

    /**
     * Load inlang project settings
     * @param {string} workspacePath 
     * @returns {Promise<Object|null>} The inlang settings or null if not found
     */
    async loadInlangSettingsAsync(workspacePath) {
        try {
            const inlangSettingsPath = path.join(workspacePath, 'project.inlang', 'settings.json');
            const fileContent = await fsPromises.readFile(inlangSettingsPath, 'utf8');
            return JSON.parse(fileContent);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log(`📝 No inlang settings found at: ${path.join(workspacePath, 'project.inlang', 'settings.json')}`);
            } else {
                console.log(`❌ Failed to load inlang settings: ${error.message}`);
            }
            return null;
        }
    }

    /**
     * Get the path pattern for translation files
     * @param {string} workspacePath 
     * @returns {Promise<string>} The path pattern for translation files
     */
    async getTranslationPathPatternAsync(workspacePath) {
        const inlangSettings = await this.loadInlangSettingsAsync(workspacePath);

        if (inlangSettings &&
            inlangSettings['plugin.inlang.messageFormat'] &&
            inlangSettings['plugin.inlang.messageFormat'].pathPattern) {
            return inlangSettings['plugin.inlang.messageFormat'].pathPattern;
        }

        // Fallback to default pattern
        return './messages/{locale}.json';
    }
    
    /**
     * normalize a workspace path
     * @param {string} workspacePath
     * @param {string} pathPattern
     * @param {string} locale
     */
    _normalizePath(workspacePath, pathPattern, locale) {
        const relativePath = pathPattern.replace('{locale}', locale);
        if (relativePath.startsWith('./')) {
            return path.join(workspacePath, relativePath.substring(2));
        }
        if (relativePath.startsWith('/')) {
            return path.join(workspacePath, relativePath.substring(1));
        }
        return path.join(workspacePath, relativePath);
    }

    
    /**
     * Resolve the actual translation file path
     * @param {string} workspacePath 
     * @param {string} locale 
     * @returns {Promise<string>} The resolved path to the translation file
     */
    async resolveTranslationPathAsync(workspacePath, locale) {
        const pathPattern = await this.getTranslationPathPatternAsync(workspacePath);
        return this._normalizePath(workspacePath, pathPattern, locale);
    }

    /**
     * get the available locales
     * @param {string} workspacePath
     */
    async getAvailableLocales(workspacePath) {
        const inlangSettings = await this.loadInlangSettingsAsync(workspacePath);
        if (Array.isArray(inlangSettings?.locales) && inlangSettings.locales.length > 0) {
            return inlangSettings.locales;
        }

        const fallbackLocale = inlangSettings?.baseLocale || 'en';
        const samplePath = await this.resolveTranslationPathAsync(workspacePath, fallbackLocale);
        const sampleDir = path.dirname(samplePath);

        try {
            const entries = await fsPromises.readdir(sampleDir, { withFileTypes: true });
            return entries
                .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
                .map(entry => path.basename(entry.name, '.json'));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.log(`❌ Failed to read locale directory: ${error.message}`);
            }
            return ['en'];
        }
    }

    /**
     * get the locale file paths
     * @param {string} workspacePath
     */
    async getLocaleFilePaths(workspacePath) {
        const locales = await this.getAvailableLocales(workspacePath);
        const results = await Promise.all(
            locales.map(async (locale) => {
                const translationPath = await this.resolveTranslationPathAsync(workspacePath, locale);
                try {
                    await fsPromises.access(translationPath);
                    return translationPath;
                } catch {
                    return null;
                }
            })
        );
        return results.filter(p => p !== null);
    }

    /**
     * Update the current locale in VS Code configuration
     * @param {string} locale The new locale to set
     * @returns {Promise<void>}
     */
    async updateLocale(locale) {
        const config = vscode.workspace.getConfiguration('elementaryWatson');
        await config.update('defaultLocale', locale, vscode.ConfigurationTarget.Workspace);
    }
}

module.exports = { LocaleService };