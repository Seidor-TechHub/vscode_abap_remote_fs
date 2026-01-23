import {
    CustomTextEditorProvider,
    ExtensionContext,
    TextDocument,
    WebviewPanel,
    Disposable,
    window,
    Uri
} from "vscode"
import { isAbapStat } from "abapfs"
import { pickAdtRoot, RemoteManager } from "../config"
import { getSapGuiCommand, SapGui } from "../adt/sapgui/sapgui"
import { uriRoot } from "../adt/conections"
import { caughtToString, setupWebGuiProxy, getDisplayUrl } from "../lib"

export class WebGuiCustomEditorProvider implements CustomTextEditorProvider {
    public static register(context: ExtensionContext) {
        const provider = new WebGuiCustomEditorProvider(context)
        const options = {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        }
        const providerRegistration = Disposable.from(
            window.registerCustomEditorProvider(
                WebGuiCustomEditorProvider.viewType,
                provider,
                options
            ),
            window.registerCustomEditorProvider(
                WebGuiCustomEditorProvider.viewTypeSecondary,
                provider,
                options
            )
        )
        return providerRegistration
    } private static readonly viewType = "abapfs.webgui"
    private static readonly viewTypeSecondary = "abapfs.webgui_secondary"

    constructor(private readonly context: ExtensionContext) { }

    public static generateWebGuiHtml(url: Uri, proxyUrl?: string, showToolbar: boolean = true): string {
        const displayUrl = proxyUrl || url.toString()
        // derive a concrete origin for postMessage (must be exact origin, wildcard not allowed)
        let origin: string
        try {
            origin = new URL(displayUrl).origin
        } catch (e) {
            origin = `${url.scheme}://${url.authority}`
        }
        const html = `<!DOCTYPE html>
        <html>
        <head>
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
            <style>
                body, html { margin: 0; padding: 0; height: 100%; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
                iframe { width: 100%; height: 100%; border: none; }
                .loading-container { 
                    display: flex; 
                    flex-direction: column; 
                    align-items: center; 
                    justify-content: center; 
                    height: 100%; 
                    background: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                }
                .error-container {
                    max-width: 600px;
                    padding: 20px;
                    text-align: center;
                }
                .retry-button {
                    margin-top: 20px;
                    padding: 10px 20px;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    cursor: pointer;
                    font-size: 14px;
                }
                .retry-button:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                .loading-spinner {
                    border: 3px solid var(--vscode-editor-foreground);
                    border-top: 3px solid transparent;
                    border-radius: 50%;
                    width: 40px;
                    height: 40px;
                    animation: spin 1s linear infinite;
                    margin-bottom: 20px;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                .hidden { display: none; }
            </style>
        </head>
        <body>
            <div id="loading" class="loading-container">
                <div class="loading-spinner"></div>
                <p>Loading SAP Web GUI...</p>
                <p id="loading-time" style="font-size: 12px; opacity: 0.7;"></p>
            </div>
            <iframe id="webgui-iframe" src="${displayUrl}" allow="clipboard-read; clipboard-write" style="display: none;"></iframe>
            <script>
                const iframe = document.getElementById('webgui-iframe');
                const loading = document.getElementById('loading');
                const loadingTime = document.getElementById('loading-time');
                let loaded = false;
                let loadStartTime = Date.now();
                let timeoutHandle = null;
                let timeUpdateInterval = null;

                // Update elapsed time display
                timeUpdateInterval = setInterval(() => {
                    if (!loaded) {
                        const elapsed = Math.floor((Date.now() - loadStartTime) / 1000);
                        loadingTime.textContent = elapsed + 's';
                    }
                }, 1000);

                // Monitor iframe load state with multiple checks
                let checkCount = 0;
                const maxChecks = 60; // 60 seconds total (increased from 30)
                
                function checkIframeLoaded() {
                    checkCount++;
                    
                    try {
                        // Try to access iframe document (will fail for cross-origin but succeed if loaded)
                        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                        const iframeWindow = iframe.contentWindow;
                        
                        // Check if iframe has loaded content
                        if (iframeDoc && iframeDoc.readyState === 'complete') {
                            onLoadSuccess();
                            return;
                        }
                        
                        // Additional check: see if iframe window exists and has location
                        if (iframeWindow && iframeWindow.location) {
                            // Cross-origin loaded successfully (will throw but means it loaded)
                            onLoadSuccess();
                            return;
                        }
                    } catch (e) {
                        // Cross-origin error means iframe loaded successfully
                        if (e.name === 'SecurityError' || e.message.includes('cross-origin')) {
                            onLoadSuccess();
                            return;
                        }
                    }
                    
                    // Continue checking if we haven't exceeded max attempts
                    if (checkCount < maxChecks && !loaded) {
                        setTimeout(checkIframeLoaded, 1000);
                    } else if (!loaded) {
                        onLoadTimeout();
                    }
                }

                function onLoadSuccess() {
                    if (loaded) return;
                    loaded = true;
                    clearInterval(timeUpdateInterval);
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                    
                    loading.style.display = 'none';
                    iframe.style.display = 'block';
                    console.log('WebGUI iframe loaded successfully');
                }

                function onLoadTimeout() {
                    if (loaded) return;
                    clearInterval(timeUpdateInterval);
                    
                    loading.innerHTML = \`
                        <div class="error-container">
                            <h1>Failed to load SAP Web GUI</h1>
                            <p>The WebGUI interface is taking longer than expected to load. This could be due to:</p>
                            <ul style="text-align: left;">
                                <li>Certificate validation issues (self-signed or expired certificates)</li>
                                <li>Network connectivity problems</li>
                                <li>Server not responding</li>
                                <li>Slow connection or proxy issues</li>
                            </ul>
                            <p><strong>Troubleshooting steps:</strong></p>
                            <ul style="text-align: left;">
                                <li>Ensure custom CA certificates are imported into Windows Trusted Root Certification Authorities</li>
                                <li>Check if the SAP server is accessible from your network</li>
                                <li>Try refreshing or reopening this tab</li>
                                <li>Check connection settings in VS Code settings</li>
                            </ul>
                            <button class="retry-button" onclick="retryLoad()">Retry Loading</button>
                        </div>
                    \`;
                }

                function retryLoad() {
                    // Reset state
                    loaded = false;
                    checkCount = 0;
                    loadStartTime = Date.now();
                    
                    // Reset UI
                    loading.innerHTML = \`
                        <div class="loading-spinner"></div>
                        <p>Loading SAP Web GUI...</p>
                        <p id="loading-time" style="font-size: 12px; opacity: 0.7;"></p>
                    \`;
                    
                    // Reload iframe
                    iframe.style.display = 'none';
                    iframe.src = iframe.src; // Force reload
                    
                    // Restart monitoring
                    timeUpdateInterval = setInterval(() => {
                        if (!loaded) {
                            const elapsed = Math.floor((Date.now() - loadStartTime) / 1000);
                            document.getElementById('loading-time').textContent = elapsed + 's';
                        }
                    }, 1000);
                    
                    checkIframeLoaded();
                }

                // Handle iframe onload event (may not always fire)
                iframe.addEventListener('load', () => {
                    onLoadSuccess();
                });

                // Handle iframe onerror event
                iframe.addEventListener('error', () => {
                    console.error('WebGUI iframe error event');
                    // Don't immediately fail, let the timeout handle it
                });

                // Start checking iframe load state
                checkIframeLoaded();

                // SAP Frame Protection handling
                window.addEventListener('message', (event) => {
                    if (event.data === 'SAPFrameProtection*require-origin') {
                        console.log('SAPFrameProtection: Unlocking parent');
                        if (event.source) {
                            event.source.postMessage('SAPFrameProtection*parent-unlocked', '${origin}');
                        }
                        // If we received a message from iframe, it means it's loaded
                        onLoadSuccess();
                    }
                });
            </script>
        </body>
        </html>`

        return html
    }

    public async resolveCustomTextEditor(
        document: TextDocument,
        webviewPanel: WebviewPanel,
        _token: any
    ): Promise<void> {
        const uri = document.uri
        try {
            const fsRoot = await pickAdtRoot(uri)
            if (!fsRoot) throw new Error("No ADT root found")

            const file = uriRoot(fsRoot.uri).getNode(uri.path)
            if (!isAbapStat(file) || !file.object.sapGuiUri) {
                webviewPanel.webview.html = "<h1>Object not supported in WebGUI</h1>"
                return
            }

            const config = await RemoteManager.get().byIdAsync(fsRoot.uri.authority)
            if (!config) throw new Error("Configuration not found")

            const sapGui = SapGui.create(config)
            const cmd = getSapGuiCommand(file.object)
            const url = sapGui.getWebGuiUrl(config, cmd)

            if (!url) {
                webviewPanel.webview.html = "<h1>Could not generate WebGUI URL</h1>"
                return
            }

            webviewPanel.webview.options = {
                enableScripts: true,
            }

            // Use shared WebGUI proxy utility for HTTPS with self-signed certificates
            const { proxyUrl } = await setupWebGuiProxy(config, url, fsRoot.uri.authority)

            webviewPanel.webview.html = WebGuiCustomEditorProvider.generateWebGuiHtml(url, proxyUrl, false)

        } catch (e) {
            webviewPanel.webview.html = `<h1>Error: ${caughtToString(e)}</h1>`
        }
    }
}
