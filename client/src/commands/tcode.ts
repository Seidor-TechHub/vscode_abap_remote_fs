import { window, ViewColumn } from "vscode"
import { RemoteManager, pickAdtRoot } from "../config"
import { SapGui, SapGuiCommand } from "../adt/sapgui/sapgui"
import { caughtToString } from "../lib"
import { WebGuiCustomEditorProvider } from "../editors/webGuiEditor"
import { startWebGuiProxy } from "../webguiProxy"
import { getClient } from "../adt/conections"

export async function runTCode() {
    try {
        // Get the active connection
        const adtRoot = await pickAdtRoot(undefined)
        if (!adtRoot) {
            window.showErrorMessage("No connection selected")
            return
        }

        const connId = adtRoot.uri.authority

        // Ask user for transaction code
        const tcode = await window.showInputBox({
            prompt: 'Enter transaction code (e.g., SE38, SE80, SM50)',
            placeHolder: 'Transaction code',
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return 'Transaction code cannot be empty'
                }
                return null
            }
        })

        if (!tcode) {
            return
        }

        // Get the connection config
        const config = RemoteManager.get().byId(connId)
        if (!config) {
            window.showErrorMessage("Connection not found")
            return
        }

        // Create the SAP GUI command for the transaction
        const cmd: SapGuiCommand = {
            type: "Transaction",
            command: tcode.trim()
        }

        // Generate Web GUI URL
        const sapGui = SapGui.create(config)
        const url = sapGui.getWebGuiUrl(config, cmd)
        if (!url) {
            window.showErrorMessage("Could not generate WebGUI URL")
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
            `Transaction ${tcode.trim()}`,
            ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        )
        panel.webview.html = WebGuiCustomEditorProvider.generateWebGuiHtml(url, htmlUrl, false)

    } catch (e) {
        window.showErrorMessage(caughtToString(e))
    }
}
