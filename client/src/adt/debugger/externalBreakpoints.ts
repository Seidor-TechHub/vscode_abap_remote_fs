import { ExtensionContext, commands, debug, window, Uri, SourceBreakpoint } from "vscode"
import { pickAdtRoot } from "../../config"
import { getClient } from "../conections"
import { DebugListener, DebuggerUI } from "./debugListener"
import { AbapDebugConfiguration } from "./abapDebugSession"
import { caughtToString, isDefined } from "../../lib"
import { isAdtError, isDebugListenerError } from "abap-adt-api"

export class ExternalBreakpointManager {
    private static instance: ExternalBreakpointManager
    private listeners = new Map<string, DebugListener>()
    private active = false

    private constructor(private context: ExtensionContext) { }

    public static register(context: ExtensionContext) {
        this.instance = new ExternalBreakpointManager(context)
        context.subscriptions.push(
            commands.registerCommand("abapfs.debug.startExternalListener", () => this.instance.startListener()),
            commands.registerCommand("abapfs.debug.stopExternalListener", () => this.instance.stopListener())
        )

        // Listen for breakpoint changes to sync them if listener is active
        context.subscriptions.push(debug.onDidChangeBreakpoints(e => {
            if (ExternalBreakpointManager.instance.active) {
                ExternalBreakpointManager.instance.syncAllBreakpoints()
            }
        }))
    }

    private async startListener() {
        const root = await pickAdtRoot()
        if (!root) return
        const connId = root.uri.authority

        if (this.listeners.has(connId)) {
            window.showInformationMessage("Listener already running for this connection")
            return
        }

        try {
            const client = getClient(connId)
            if (!client) throw new Error("Not connected")

            const ui: DebuggerUI = {
                Confirmator: async (msg) => {
                    const res = await window.showInformationMessage(msg, "Yes", "No")
                    return res === "Yes"
                },
                ShowError: (msg) => window.showErrorMessage(msg)
            }

            // Create a listener in "user" mode (terminalMode = false)
            const listener = await DebugListener.create(connId, ui, client.username, false)
            this.listeners.set(connId, listener)
            this.active = true

            await this.syncBreakpoints(listener, connId)

            // Start listening loop
            this.runListenerLoop(listener, connId)

            window.showInformationMessage(`External Debug Listener started for ${connId}`)
        } catch (e) {
            window.showErrorMessage(`Failed to start listener: ${caughtToString(e)}`)
        }
    }

    private async stopListener() {
        this.active = false
        for (const [connId, listener] of this.listeners) {
            // We can't easily stop the blocking call, but we can flag it
            // The loop checks this.listeners.has(connId)
        }
        this.listeners.clear()
        window.showInformationMessage("External Debug Listeners stopped")
    }

    private async syncAllBreakpoints() {
        for (const [connId, listener] of this.listeners) {
            await this.syncBreakpoints(listener, connId)
        }
    }

    private async syncBreakpoints(listener: DebugListener, connId: string) {
        const breakpoints = debug.breakpoints.filter(b => b instanceof SourceBreakpoint) as SourceBreakpoint[]

        const byFile = new Map<string, SourceBreakpoint[]>()
        for (const bp of breakpoints) {
            if (bp.location.uri.authority === connId) {
                const path = bp.location.uri.toString()
                const list = byFile.get(path) || []
                list.push(bp)
                byFile.set(path, list)
            }
        }

        for (const [path, bps] of byFile) {
            const source = { path, name: path.split('/').pop() }
            const debugBps = bps.map(b => ({
                line: b.location.range.start.line + 1,
                column: b.location.range.start.character
            }))

            await listener.breakpointManager.setBreakpoints(source, debugBps)
        }
    }

    private async runListenerLoop(listener: DebugListener, connId: string) {
        const client = listener.client
        const { terminalId, ideId, username } = listener

        while (this.listeners.has(connId)) {
            try {
                const debuggee = await client.statelessClone.debuggerListen("user", terminalId, ideId, username)

                if (!this.listeners.has(connId)) break // Stopped while waiting

                if (debuggee && !isDebugListenerError(debuggee)) {
                    // We got a debuggee!
                    // Start VS Code Debug Session
                    const config: AbapDebugConfiguration = {
                        type: "abap",
                        name: "Auto Attach",
                        request: "attach",
                        connId,
                        debugUser: username,
                        terminalMode: false,
                        debuggee: debuggee
                    }

                    // Stop our listener to avoid conflict
                    this.listeners.delete(connId)

                    await debug.startDebugging(undefined, config)
                    return // Exit loop
                }
            } catch (e) {
                if (isAdtError(e)) {
                    // Handle timeout or other ADT errors
                    // If timeout, just continue
                } else {
                    // Log error?
                }
                // Small delay to avoid tight loop on error
                await new Promise(resolve => setTimeout(resolve, 1000))
            }
        }
    }
}
