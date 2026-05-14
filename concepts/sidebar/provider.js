const vscode = require('vscode');
const path = require('path');

/**
 * Tree data provider for the ElementaryWatson sidebar
 */
class SidebarTreeProvider {
    constructor(sidebarService, localeService, translationService) {
        if (!localeService || !translationService) {
            throw new Error('SidebarTreeProvider requires localeService and translationService');
        }
        this.sidebarService = sidebarService;
        this.localeService = localeService;
        this.translationService = translationService;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.translationData = [];
        this.currentFilePath = null;
        this.clearTimeout = null; // Debounce clearing to handle editor switching
    }

    /**
     * Set the tree view instance for title updates
     * @param {vscode.TreeView} treeView The tree view instance
     */
    setTreeView(treeView) {
        this.treeView = treeView;
    }

    /**
     * Update the tree view title based on current context
     */
    updateTitle() {
        if (!this.treeView) return;
        
        if (this.currentFilePath && this.translationData.length > 0) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.currentFilePath));
            let displayPath = this.currentFilePath;
            
            if (workspaceFolder) {
                displayPath = path.relative(workspaceFolder.uri.fsPath, this.currentFilePath);
            }
            
            if (!displayPath.startsWith('/')) {
                displayPath = '/' + displayPath;
            }
            
            const keyCount = this.translationData.length;
            this.treeView.title = `${displayPath} (${keyCount} ${keyCount === 1 ? 'key' : 'keys'})`;
        } else {
            this.treeView.title = 'Translation Keys';
        }
    }

    /**
     * Refresh the tree view
     * @param {vscode.TextDocument} document The current document
     * @param {boolean} force Force refresh even if it's a translation file
     */
    async refresh(document, force = false) {
        if (this.clearTimeout) {
            clearTimeout(this.clearTimeout);
            this.clearTimeout = null;
        }
        
        if (document) {
            const isTransFile = await this.sidebarService.isTranslationFile(document);
            
            if (!force && isTransFile) {
                this._onDidChangeTreeData.fire();
                this.updateTitle();
                return;
            }
            
            this.translationData = await this.sidebarService.getTranslationData(document);
            this.currentFilePath = document.uri.fsPath;
        } else {
            this.clearTimeout = setTimeout(() => {
                this.translationData = [];
                this.currentFilePath = null;
                this._onDidChangeTreeData.fire();
                this.updateTitle();
                this.clearTimeout = null;
            }, 150);
            return;
        }
        this._onDidChangeTreeData.fire();
        this.updateTitle();
    }

    /**
     * Get tree item for display
     * @param {vscode.TreeItem} element The tree element
     * @returns {vscode.TreeItem} The tree item
     */
    getTreeItem(element) {
        return element;
    }

    /**
     * Get children for a tree element
     * @param {vscode.TreeItem} element The parent element
     * @returns {Promise<vscode.TreeItem[]>} The children
     */
    async getChildren(element) {
        if (!element) {
            const currentLocale = await this.localeService.getCurrentLocale();
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            
            if (!workspaceFolder) {
                return this.translationData.map(keyData => 
                    new TranslationKeyNode(keyData.key, keyData.locales.length)
                );
            }
            
            const workspacePath = workspaceFolder.uri.fsPath;
            
            let currentTranslations = null;
            try {
                currentTranslations = await this.translationService.loadTranslationsForLocale(workspacePath, currentLocale);
            } catch (error) {
                console.error('Failed to load translations:', error);
            }
            
            return this.translationData.map(keyData => {
                let currentValue = null;
                if (currentTranslations) {
                    currentValue = this.translationService.getTranslation(currentTranslations, keyData.key);
                }
                
                return new TranslationKeyNode(keyData.key, keyData.locales.length, currentValue);
            });
        }

        if (element instanceof TranslationKeyNode) {
            const keyData = this.translationData.find(data => data.key === element.key);
            if (keyData) {
                return keyData.locales.map(localeData => 
                    new TranslationItemNode(
                        localeData.locale,
                        localeData.value,
                        element.key,
                        localeData.workspacePath
                    )
                );
            }
        }

        return [];
    }
}

/**
 * Tree node for translation keys
 */
class TranslationKeyNode extends vscode.TreeItem {
    constructor(key, localeCount, currentValue = null) {
        super(key, vscode.TreeItemCollapsibleState.Collapsed);
        this.key = key;
        
        if (currentValue) {
            const displayValue = currentValue.length > 40 ? currentValue.substring(0, 37) + '...' : currentValue;
            this.description = `"${displayValue}" • ${localeCount} ${localeCount === 1 ? 'locale' : 'locales'}`;
        } else {
            this.description = `(no value) • ${localeCount} ${localeCount === 1 ? 'locale' : 'locales'}`;
        }
        
        this.contextValue = 'translationKey';
    }
}

/**
 * Tree node for individual translation items (locale + value)
 */
class TranslationItemNode extends vscode.TreeItem {
    constructor(locale, value, key, workspacePath) {
        const displayValue = value.length > 50 ? value.substring(0, 47) + '...' : value;
        const label = `[${locale}] "${displayValue}"`;
        
        super(label, vscode.TreeItemCollapsibleState.None);
        
        this.locale = locale;
        this.value = value;
        this.key = key;
        this.workspacePath = workspacePath;
        this.contextValue = 'translationItem';
        
        this.command = {
            command: 'elementaryWatson.openTranslationFile',
            title: 'Navigate to translation',
            arguments: [this.workspacePath, this.locale, this.key]
        };

        if (!value || value.trim() === '') {
            this.description = '(empty) → click to navigate';
        } else {
            this.description = '→ click to navigate';
        }
    }
}

module.exports = { SidebarTreeProvider, TranslationKeyNode, TranslationItemNode };