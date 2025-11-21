import {
    CustomTextEditorProvider,
    ExtensionContext,
    TextDocument,
    WebviewPanel,
    Disposable,
    window,
    Uri,
    env,
    commands
} from "vscode"
import { isAbapStat } from "abapfs"
import { pickAdtRoot, RemoteManager } from "../config"
import { getSapGuiCommand, SapGui } from "../adt/sapgui/sapgui"
import { uriRoot } from "../adt/conections"
import { caughtToString } from "../lib"

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
    private webGuiPanels = new Map<WebviewPanel, Uri>()

    constructor(private readonly context: ExtensionContext) {
        commands.registerCommand("abapfs.webgui.openExternal", () => this.openWebGuiExternal())
        commands.registerCommand("abapfs.webgui.copyUrl", () => this.copyWebGuiUrl())
    }

    private async openWebGuiExternal() {
        const panel = [...this.webGuiPanels.keys()].find(p => p.active)
        if (panel) {
            const url = this.webGuiPanels.get(panel)
            if (url) env.openExternal(url)
        }
    }

    private async copyWebGuiUrl() {
        const panel = [...this.webGuiPanels.keys()].find(p => p.active)
        if (panel) {
            const url = this.webGuiPanels.get(panel)
            if (url) {
                env.clipboard.writeText(url.toString())
                window.showInformationMessage('URL copied to clipboard')
            }
        }
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

            this.webGuiPanels.set(webviewPanel, url)
            webviewPanel.onDidDispose(() => this.webGuiPanels.delete(webviewPanel))

            webviewPanel.webview.options = {
                enableScripts: true,
            }

            const origin = `${url.scheme}://${url.authority}`
            webviewPanel.webview.html = `<!DOCTYPE html>
            <html>
            <head>
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
                <style>
                    body, html { margin: 0; padding: 0; height: 100%; overflow: hidden; }
                    iframe { width: 100%; height: 100%; border: none; }
                </style>
            </head>
            <body>
                <iframe src="${url.toString()}" allow="clipboard-read; clipboard-write"></iframe>
                <script>
                    window.addEventListener('message', (event) => {
                        if (event.data === 'SAPFrameProtection*require-origin') {
                            console.log('SAPFrameProtection: Unlocking parent');
                            if (event.source) {
                                event.source.postMessage('SAPFrameProtection*parent-unlocked', '${origin}');
                            }
                        }
                    });
                </script>
            </body>
            </html>`

        } catch (e) {
            webviewPanel.webview.html = `<h1>Error: ${caughtToString(e)}</h1>`
        }
    }
}
