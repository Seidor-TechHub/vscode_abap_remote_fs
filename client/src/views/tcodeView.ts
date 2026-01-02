import {
    window,
    Disposable,
    WebviewViewProvider,
    WebviewView,
    WebviewViewResolveContext,
    CancellationToken,
    Uri,
    ViewColumn
} from "vscode"
import { pickAdtRoot, RemoteManager } from "../config"
import { caughtToString } from "../lib"
import { SapGui, SapGuiCommand } from "../adt/sapgui/sapgui"
import { WebGuiCustomEditorProvider } from "../editors/webGuiEditor"
import { startWebGuiProxy } from "../webguiProxy"
import { getClient } from "../adt/conections"

export class TCodeViewProvider implements WebviewViewProvider, Disposable {
    public static readonly viewType = "abapfs.views.tcode"

    private static _instance: TCodeViewProvider
    private _view?: WebviewView
    private _tcodeHistory: string[] = []
    private readonly MAX_HISTORY = 20

    constructor() { }

    public static get() {
        if (!TCodeViewProvider._instance) {
            TCodeViewProvider._instance = new TCodeViewProvider()
        }
        return TCodeViewProvider._instance
    }

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

        webviewView.webview.html = this.getHtmlForWebview()

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case "runTCode":
                    await this.runTransaction(data.tcode)
                    break
                case "getHistory":
                    this._view?.webview.postMessage({
                        type: "history",
                        history: this._tcodeHistory
                    })
                    break
            }
        })
    }

    private addToHistory(tcode: string) {
        // Remove if exists to avoid duplicates
        const index = this._tcodeHistory.indexOf(tcode.toUpperCase())
        if (index > -1) {
            this._tcodeHistory.splice(index, 1)
        }
        // Add to front
        this._tcodeHistory.unshift(tcode.toUpperCase())
        // Keep only MAX_HISTORY items
        if (this._tcodeHistory.length > this.MAX_HISTORY) {
            this._tcodeHistory = this._tcodeHistory.slice(0, this.MAX_HISTORY)
        }
        // Update the view
        this._view?.webview.postMessage({
            type: "history",
            history: this._tcodeHistory
        })
    }

    private async runTransaction(tcode: string) {
        if (!this._view) return
        if (!tcode || tcode.trim().length === 0) {
            this._view.webview.postMessage({ type: "error", message: "Please enter a transaction code" })
            return
        }

        try {
            this._view.webview.postMessage({ type: "status", message: "Running transaction..." })

            // Get the active connection
            const adtRoot = await pickAdtRoot(undefined)
            if (!adtRoot) {
                this._view.webview.postMessage({ type: "error", message: "No connection selected" })
                return
            }

            const connId = adtRoot.uri.authority

            // Get the connection config
            const config = RemoteManager.get().byId(connId)
            if (!config) {
                this._view.webview.postMessage({ type: "error", message: "Connection not found" })
                return
            }

            // Add to history
            this.addToHistory(tcode.trim())

            // Create the SAP GUI command for the transaction
            const cmd: SapGuiCommand = {
                type: "Transaction",
                command: tcode.trim()
            }

            // Generate Web GUI URL
            const sapGui = SapGui.create(config)
            const url = sapGui.getWebGuiUrl(config, cmd)
            if (!url) {
                this._view.webview.postMessage({ type: "error", message: "Could not generate WebGUI URL" })
                return
            }

            // Set up proxy for HTTPS with self-signed certificates
            let proxyUrl: string | undefined = undefined
            if (url.scheme === "https" && config.allowSelfSigned) {
                try {
                    const targetBaseUrl = `${url.scheme}://${url.authority}`
                    let extraHeaders: { [k: string]: string } | undefined = undefined
                    try {
                        const client = getClient(connId)
                        if (client && (client as any).reentranceTicket) {
                            const ticket = await (client as any).reentranceTicket()
                            if (ticket) {
                                extraHeaders = {
                                    "sap-mysapsso": `${config.client}${ticket}`,
                                    "sap-mysapred": url.toString()
                                }
                            }
                        }
                    } catch (e) {
                        // ignore ticket errors
                    }
                    const port = await startWebGuiProxy(targetBaseUrl, true, config.customCA, extraHeaders)
                    proxyUrl = `http://127.0.0.1:${port}${url.path}${url.query ? '?' + url.query : ''}`
                } catch (e) {
                    console.error("Failed to start proxy:", e)
                }
            }

            // Only use proxy if allowSelfSigned and HTTPS, otherwise use direct URL
            const htmlUrl = (url.scheme === "https" && config.allowSelfSigned) ? proxyUrl : undefined

            // Create embedded webview panel
            const panel = window.createWebviewPanel(
                'abapTCode',
                `Transaction ${tcode.trim().toUpperCase()}`,
                ViewColumn.Active,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            )
            panel.webview.html = WebGuiCustomEditorProvider.generateWebGuiHtml(url, htmlUrl, false)

            this._view.webview.postMessage({ type: "success", message: `Opened ${tcode.trim().toUpperCase()}` })

        } catch (e) {
            this._view.webview.postMessage({ type: "error", message: caughtToString(e) })
        }
    }

    private getHtmlForWebview(): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Transaction Code</title>
            <style>
                * {
                    box-sizing: border-box;
                }
                body {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    padding: 8px;
                    margin: 0;
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-sideBar-background);
                }
                .tcode-container {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .input-row {
                    display: flex;
                    gap: 4px;
                    align-items: center;
                }
                .tcode-input {
                    flex: 1;
                    padding: 6px 8px;
                    font-size: 13px;
                    font-family: var(--vscode-editor-font-family);
                    text-transform: uppercase;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 2px;
                    outline: none;
                }
                .tcode-input:focus {
                    border-color: var(--vscode-focusBorder);
                }
                .tcode-input::placeholder {
                    text-transform: none;
                    color: var(--vscode-input-placeholderForeground);
                }
                .run-button {
                    padding: 6px 12px;
                    font-size: 12px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 2px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    white-space: nowrap;
                }
                .run-button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .run-button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                .run-icon {
                    font-size: 14px;
                }
                .status-message {
                    font-size: 11px;
                    padding: 4px 0;
                    min-height: 18px;
                }
                .status-message.error {
                    color: var(--vscode-errorForeground);
                }
                .status-message.success {
                    color: var(--vscode-terminal-ansiGreen);
                }
                .status-message.info {
                    color: var(--vscode-descriptionForeground);
                }
                .history-container {
                    margin-top: 8px;
                }
                .history-label {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 4px;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }
                .history-list {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 4px;
                }
                .history-item {
                    padding: 2px 8px;
                    font-size: 11px;
                    font-family: var(--vscode-editor-font-family);
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    border-radius: 10px;
                    cursor: pointer;
                    border: none;
                }
                .history-item:hover {
                    background-color: var(--vscode-button-secondaryHoverBackground);
                }
                .quick-tcodes {
                    margin-top: 12px;
                    padding-top: 8px;
                    border-top: 1px solid var(--vscode-widget-border);
                }
                .quick-label {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 6px;
                }
                .quick-buttons {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 4px;
                }
                .quick-button {
                    padding: 4px 10px;
                    font-size: 11px;
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: none;
                    border-radius: 2px;
                    cursor: pointer;
                }
                .quick-button:hover {
                    background-color: var(--vscode-button-secondaryHoverBackground);
                }
            </style>
        </head>
        <body>
            <div class="tcode-container">
                <div class="input-row">
                    <input type="text" 
                           id="tcode-input" 
                           class="tcode-input" 
                           placeholder="SE38, SM50..." 
                           autocomplete="off"
                           spellcheck="false" />
                    <button id="run-button" class="run-button">
                        <span class="run-icon">▶</span>
                        Run
                    </button>
                </div>
                <div id="status-message" class="status-message"></div>
                
                <div id="history-container" class="history-container" style="display: none;">
                    <div class="history-label">
                        <span>📋</span> Recent
                    </div>
                    <div id="history-list" class="history-list"></div>
                </div>

                <div class="quick-tcodes">
                    <div class="quick-label">Common Transactions</div>
                    <div class="quick-buttons">
                        <button class="quick-button" data-tcode="SE38">SE38</button>
                        <button class="quick-button" data-tcode="SE80">SE80</button>
                        <button class="quick-button" data-tcode="SE24">SE24</button>
                        <button class="quick-button" data-tcode="SE37">SE37</button>
                        <button class="quick-button" data-tcode="SE11">SE11</button>
                        <button class="quick-button" data-tcode="SM50">SM50</button>
                        <button class="quick-button" data-tcode="SM21">SM21</button>
                        <button class="quick-button" data-tcode="ST22">ST22</button>
                        <button class="quick-button" data-tcode="SE16">SE16</button>
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const tcodeInput = document.getElementById('tcode-input');
                const runButton = document.getElementById('run-button');
                const statusMessage = document.getElementById('status-message');
                const historyContainer = document.getElementById('history-container');
                const historyList = document.getElementById('history-list');
                const quickButtons = document.querySelectorAll('.quick-button');

                // Restore state
                const previousState = vscode.getState();
                if (previousState && previousState.tcode) {
                    tcodeInput.value = previousState.tcode;
                }

                // Request history on load
                vscode.postMessage({ type: 'getHistory' });

                function runTCode() {
                    const tcode = tcodeInput.value.trim();
                    if (tcode) {
                        runButton.disabled = true;
                        vscode.postMessage({ type: 'runTCode', tcode });
                        vscode.setState({ tcode });
                    }
                }

                runButton.addEventListener('click', runTCode);

                tcodeInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        runTCode();
                    }
                });

                tcodeInput.addEventListener('input', () => {
                    vscode.setState({ tcode: tcodeInput.value });
                });

                // Quick buttons
                quickButtons.forEach(btn => {
                    btn.addEventListener('click', () => {
                        const tcode = btn.dataset.tcode;
                        tcodeInput.value = tcode;
                        vscode.setState({ tcode });
                        runTCode();
                    });
                });

                // Handle messages from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'error':
                            statusMessage.textContent = message.message;
                            statusMessage.className = 'status-message error';
                            runButton.disabled = false;
                            break;
                        case 'success':
                            statusMessage.textContent = message.message;
                            statusMessage.className = 'status-message success';
                            runButton.disabled = false;
                            setTimeout(() => {
                                statusMessage.textContent = '';
                            }, 3000);
                            break;
                        case 'status':
                            statusMessage.textContent = message.message;
                            statusMessage.className = 'status-message info';
                            break;
                        case 'history':
                            renderHistory(message.history);
                            break;
                    }
                });

                function renderHistory(history) {
                    if (history && history.length > 0) {
                        historyContainer.style.display = 'block';
                        historyList.innerHTML = '';
                        history.forEach(tcode => {
                            const item = document.createElement('button');
                            item.className = 'history-item';
                            item.textContent = tcode;
                            item.addEventListener('click', () => {
                                tcodeInput.value = tcode;
                                vscode.setState({ tcode });
                                runTCode();
                            });
                            historyList.appendChild(item);
                        });
                    } else {
                        historyContainer.style.display = 'none';
                    }
                }
            </script>
        </body>
        </html>`
    }
}
