import {
    window,
    Disposable,
    WebviewViewProvider,
    WebviewView,
    WebviewViewResolveContext,
    CancellationToken,
    Uri,
    commands
} from "vscode"
import { AdtObjectFinder, MySearchResult } from "../adt/operations/AdtObjectFinder"
import { pickAdtRoot } from "../config"
import { openObject } from "../commands/commands"
import { caughtToString } from "../lib"
import { getClient } from "../adt/conections"

export class AbapObjectSearchProvider implements WebviewViewProvider, Disposable {
    private _view?: WebviewView
    private lastResults: MySearchResult[] = []
    private currentConnId?: string

    constructor() { }

    public dispose() { }

    public resolveWebviewView(
        webviewView: WebviewView,
        context: WebviewViewResolveContext,
        _token: CancellationToken
    ) {
        this._view = webviewView

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: []
        }

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview)

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case "search":
                    await this.performSearch(data.query)
                    break
                case "open":
                    await this.openObject(data.uri)
                    break
            }
        })
    }

    private async performSearch(query: string) {
        if (!this._view) return

        try {
            // We need a connection to search. 
            // If there is an active editor, use that connection.
            // Otherwise, we might need to ask the user or pick a default.
            // For now, let's try to pick a root based on current context or ask user.
            const adtRoot = await pickAdtRoot(undefined)
            if (!adtRoot) {
                this._view.webview.postMessage({ type: "error", message: "No connection selected" })
                return
            }

            const connId = adtRoot.uri.authority
            this.currentConnId = connId
            const finder = new AdtObjectFinder(connId)
            const client = getClient(connId)
            
            const results = await finder.search(query, client)
            this.lastResults = results
            
            this._view.webview.postMessage({ type: "searchResults", results })

        } catch (e) {
            this._view.webview.postMessage({ type: "error", message: caughtToString(e) })
        }
    }

    private async openObject(uri: string) {
        try {
             if (this.currentConnId) {
                 await openObject(this.currentConnId, uri)
             } else {
                 // Fallback if for some reason connId is lost (shouldn't happen if search was done)
                 const adtRoot = await pickAdtRoot(undefined)
                 if (adtRoot) {
                     await openObject(adtRoot.uri.authority, uri)
                 }
             }

        } catch (e) {
            window.showErrorMessage(caughtToString(e))
        }
    }

    private getHtmlForWebview(webview: any): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>ABAP Object Search</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 10px;
                    color: var(--vscode-editor-foreground);
                    background-color: var(--vscode-editor-background);
                }
                .search-container {
                    display: flex;
                    gap: 10px;
                    margin-bottom: 10px;
                }
                input[type="text"] {
                    flex-grow: 1;
                    padding: 5px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                }
                button {
                    padding: 5px 10px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    cursor: pointer;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                }
                th, td {
                    text-align: left;
                    padding: 5px;
                    border-bottom: 1px solid var(--vscode-editor-lineHighlightBorder);
                }
                th {
                    color: var(--vscode-descriptionForeground);
                }
                tr:hover {
                    background-color: var(--vscode-list-hoverBackground);
                    cursor: pointer;
                }
                .error {
                    color: var(--vscode-errorForeground);
                    margin-top: 10px;
                }
            </style>
        </head>
        <body>
            <div class="search-container">
                <input type="text" id="search-input" placeholder="Search ABAP object..." />
                <button id="search-button">Search</button>
            </div>
            <div id="results-container">
                <table id="results-table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Type</th>
                            <th>Description</th>
                        </tr>
                    </thead>
                    <tbody>
                    </tbody>
                </table>
            </div>
            <div id="error-message" class="error"></div>

            <script>
                const vscode = acquireVsCodeApi();
                const searchInput = document.getElementById('search-input');
                const searchButton = document.getElementById('search-button');
                const resultsTableBody = document.querySelector('#results-table tbody');
                const errorMessage = document.getElementById('error-message');

                // Restore state
                const previousState = vscode.getState();
                if (previousState) {
                    if (previousState.query) {
                        searchInput.value = previousState.query;
                    }
                    if (previousState.results) {
                        renderResults(previousState.results);
                    }
                }

                searchButton.addEventListener('click', () => {
                    const query = searchInput.value;
                    if (query) {
                        vscode.postMessage({ type: 'search', query });
                        errorMessage.textContent = '';
                        resultsTableBody.innerHTML = '<tr><td colspan="3">Searching...</td></tr>';
                    }
                });

                searchInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        searchButton.click();
                    }
                });

                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'searchResults':
                            renderResults(message.results);
                            vscode.setState({ query: searchInput.value, results: message.results });
                            break;
                        case 'error':
                            errorMessage.textContent = message.message;
                            resultsTableBody.innerHTML = '';
                            break;
                    }
                });

                function renderResults(results) {
                    resultsTableBody.innerHTML = '';
                    if (results.length === 0) {
                        resultsTableBody.innerHTML = '<tr><td colspan="3">No results found</td></tr>';
                        return;
                    }
                    results.forEach(result => {
                        const row = document.createElement('tr');
                        row.innerHTML = \`
                            <td>\${result.name}</td>
                            <td>\${result.type}</td>
                            <td>\${result.description || ''}</td>
                        \`;
                        row.addEventListener('click', () => {
                            vscode.postMessage({ type: 'open', uri: result.uri });
                        });
                        resultsTableBody.appendChild(row);
                    });
                }
            </script>
        </body>
        </html>`;
    }
}
