import {
    window,
    Disposable,
    Uri,
    WebviewViewProvider,
    WebviewView,
    WebviewViewResolveContext,
    CancellationToken
} from "vscode"
import { AbapObject } from "abapobject"
import { uriAbapFile } from "../adt/operations/AdtObjectFinder"
import { ADTSCHEME } from "../adt/conections"
import { commands } from "vscode"
import { AbapFsCommands } from "../commands/registry"

export class ObjectPropertiesProvider implements WebviewViewProvider, Disposable {
    private currentObject?: AbapObject
    private disposables: Disposable[] = []
    private _view?: WebviewView

    constructor() {
        this.disposables.push(window.onDidChangeActiveTextEditor(editor => {
            this.refresh(editor?.document.uri)
        }))
        if (window.activeTextEditor) {
            this.refresh(window.activeTextEditor.document.uri)
        }
    }

    resolveWebviewView(webviewView: WebviewView, context: WebviewViewResolveContext, _token: CancellationToken) {
        this._view = webviewView
        webviewView.webview.options = { enableScripts: true }
        webviewView.webview.onDidReceiveMessage(async msg => {
            if (msg && msg.command === "revealTransport" && msg.transport) {
                // trigger the reveal command (implemented in transports provider)
                await commands.executeCommand(AbapFsCommands.revealTransport, msg.transport)
            }
        })
        this.updateContent()
    }

    private async refresh(uri?: Uri) {
        if (uri && uri.scheme === ADTSCHEME) {
            const file = uriAbapFile(uri)
            if (file) {
                this.currentObject = file.object
                // Ensure structure is loaded to get metadata
                try {
                    await this.currentObject.loadStructure()
                } catch (e) {
                    // ignore error, might be already loaded or not loadable
                }
            } else {
                this.currentObject = undefined
            }
        } else {
            this.currentObject = undefined
        }
        this.updateContent()
    }

    private updateContent() {
        if (!this._view) return

        let html = `<!DOCTYPE html>
        <html>
        <head>
            <style>
                table { width: 100%; border-collapse: collapse; }
                th, td { text-align: left; padding: 5px; border-bottom: 1px solid var(--vscode-editor-lineHighlightBorder); }
                th { color: var(--vscode-descriptionForeground); }
                body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
            </style>
        </head>
        <body>`

        if (this.currentObject) {
            const obj = this.currentObject
            html += `<table>`
            html += `<tr><th>Property</th><th>Value</th></tr>`
            html += `<tr><td>Name</td><td>${obj.name}</td></tr>`
            html += `<tr><td>Type</td><td>${obj.type}</td></tr>`

            if (obj.structure?.metaData) {
                const md = obj.structure.metaData as any
                const addRow = (label: string, val: any) => {
                    if (val) html += `<tr><td>${label}</td><td>${val}</td></tr>`
                }
                if (md["adtcore:description"]) addRow("Description", md["adtcore:description"])
                if (md["adtcore:packageName"]) addRow("Package", md["adtcore:packageName"])
                if (md["adtcore:responsible"]) addRow("Created By", md["adtcore:responsible"])
                if (md["adtcore:createdAt"]) addRow("Created At", new Date(md["adtcore:createdAt"]).toLocaleString())
                if (md["adtcore:changedBy"]) addRow("Changed By", md["adtcore:changedBy"])
                if (md["adtcore:changedAt"]) addRow("Changed At", new Date(md["adtcore:changedAt"]).toLocaleString())
                if (md["adtcore:version"]) addRow("Version", md["adtcore:version"])
                if (md["adtcore:masterLanguage"]) addRow("Master Language", md["adtcore:masterLanguage"])
                // try to detect transport/request numbers in metadata
                const transportKeys = Object.keys(md).filter(k => k.toLowerCase().includes("transport"))
                for (const k of transportKeys) {
                    const val = md[k]
                    if (!val) continue
                    // if a single transport string or array
                    if (Array.isArray(val)) {
                        const links = val.map((t: any) => `<a href="#" data-transport="${t}" onclick="(function(t){window.acquireVsCodeApi().postMessage({command:'revealTransport', transport:t})})('${t}');return false;">${t}</a>`).join(", ")
                        addRow("Transport(s)", links)
                    } else if (typeof val === "string") {
                        const transportLink = `<a href="#" data-transport="${val}" onclick="(function(t){window.acquireVsCodeApi().postMessage({command:'revealTransport', transport:t})})('${val}');return false;">${val}</a>`
                        addRow("Transport", transportLink)
                    }
                }
                // also check links for potential transport-related relations
                if (obj.structure.links) {
                    const tlinks = (obj.structure.links as any[]).filter(l => l.rel && l.rel.toLowerCase().includes("transport"))
                    if (tlinks.length) {
                        const links = tlinks.map(l => `<a href="#" onclick="(function(u){window.acquireVsCodeApi().postMessage({command:'revealTransport', transport:u})})('${l.href}');return false;">${l.href}</a>`).join("<br>")
                        addRow("Transport links", links)
                    }
                }
            }
            html += `</table>`
        } else {
            html += `<p>No active ABAP object</p>`
        }

        html += `</body></html>`
        this._view.webview.html = html
    }

    dispose() {
        this.disposables.forEach(d => d.dispose())
    }
}

export const objectPropertiesProvider = new ObjectPropertiesProvider()
