const vscode = require('vscode');
const fsPromises = require('fs/promises');
const path = require('path');

class LocaleService {
    async getCurrentLocale() {
        const config = vscode.workspace.getConfiguration('elementaryWatson');
        const configLocale = config.get('defaultLocale');
        if (configLocale) {
            return configLocale;
        }

        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const inlangSettings = await this.loadInlangSettingsAsync(vscode.workspace.workspaceFolders[0].uri.fsPath);
            if (inlangSettings && inlangSettings.baseLocale) {
                return inlangSettings.baseLocale;
            }
        }

        return 'en';
    }

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

    async getTranslationPathPatternAsync(workspacePath) {
        const inlangSettings = await this.loadInlangSettingsAsync(workspacePath);
        if (inlangSettings &&
            inlangSettings['plugin.inlang.messageFormat'] &&
            inlangSettings['plugin.inlang.messageFormat'].pathPattern) {
            return inlangSettings['plugin.inlang.messageFormat'].pathPattern;
        }

        return './messages/{locale}.json';
    }

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

    async resolveTranslationPathAsync(workspacePath, locale) {
        const pathPattern = await this.getTranslationPathPatternAsync(workspacePath);
        return this._normalizePath(workspacePath, pathPattern, locale);
    }

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

    async updateLocale(locale) {
        const config = vscode.workspace.getConfiguration('elementaryWatson');
        await config.update('defaultLocale', locale, vscode.ConfigurationTarget.Workspace);
    }
}

module.exports = { LocaleService };