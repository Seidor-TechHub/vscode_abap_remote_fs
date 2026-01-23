import { WebviewView, WebviewViewProvider, window, commands, debug, DebugSession, Range, Selection, TextEditorSelectionChangeKind, TextDocument } from "vscode"

interface VariableInfo {
    name: string
    value: string
    type?: string
    variablesReference?: number
}

export class VariableTracker implements WebviewViewProvider {
    public static readonly viewType = 'abapfs.views.variableTracker'
    private _view?: WebviewView
    private _variables: Map<string, VariableInfo> = new Map()
    private static _instance: VariableTracker
    private lastSelection: Selection | undefined
    private lastDoc: TextDocument | undefined

    private constructor() {
        // Register debug adapter tracker to listen for 'stopped' events
        debug.registerDebugAdapterTrackerFactory('abap', {
            createDebugAdapterTracker: (session: DebugSession) => {
                return {
                    onDidSendMessage: (message: any) => {
                        if (message.type === 'event' && message.event === 'stopped') {
                            this.refreshValues()
                        }
                    }
                }
            }
        })

        window.onDidChangeTextEditorSelection(e => {
            if (debug.activeDebugSession && debug.activeDebugSession.type === 'abap') {
                const currentDoc = e.textEditor.document
                if (currentDoc !== this.lastDoc) {
                    this.lastSelection = undefined
                    this.lastDoc = currentDoc
                }

                if (e.selections.length === 1 && e.selections[0]) {
                    const currentSelection = e.selections[0]

                    // Check for double click pattern: Mouse event, current is word, previous was empty (cursor)
                    if (e.kind === TextEditorSelectionChangeKind.Mouse && !currentSelection.isEmpty) {
                        const wordRange = currentDoc.getWordRangeAtPosition(currentSelection.start)

                        if (wordRange && wordRange.isEqual(currentSelection)) {
                            // It is a word selection.
                            // Check if previous was empty and related (cursor was inside/at boundary of the word)
                            if (this.lastSelection && this.lastSelection.isEmpty && wordRange.contains(this.lastSelection.start)) {
                                // Check if in comment
                                const lineText = currentDoc.lineAt(currentSelection.start.line).text
                                if (this.isComment(lineText, currentSelection.start.character)) return

                                // Expand selection to include structure components (e.g. ls_struc-field, ref->comp, class=>comp)
                                const variableRange = currentDoc.getWordRangeAtPosition(currentSelection.start, /[\w\-\>~<\/\=]+/)
                                const text = currentDoc.getText(variableRange || currentSelection).trim()

                                // Check if keyword
                                if (this.isKeyword(text)) return

                                // Simple check: if it looks like a variable (no spaces, not too long)
                                if (text && text.length < 60 && !text.includes(' ')) {
                                    this.addVariable(text, true)
                                }
                            }
                        }
                    }
                    this.lastSelection = currentSelection
                }
            }
        })
    }

    public static get instance() {
        if (!this._instance) {
            this._instance = new VariableTracker()
        }
        return this._instance
    }

    public resolveWebviewView(webviewView: WebviewView) {
        this._view = webviewView
        webviewView.webview.options = {
            enableScripts: true
        }
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'addVariable':
                    await this.addVariable(message.name)
                    break
                case 'removeVariable':
                    this.removeVariable(message.name)
                    break
                case 'refresh':
                    await this.refreshValues()
                    break
                case 'viewAsTable':
                    await this.viewAsTable(message.name)
                    break
                case 'updateVariable':
                    await this.updateVariableName(message.oldName, message.newName)
                    break
                case 'updateVariableValue':
                    await this.updateVariableValue(message.name, message.value)
                    break
            }
        })
        this.update()
    }

    public async updateVariableName(oldName: string, newName: string) {
        if (this._variables.has(oldName)) {
            this._variables.delete(oldName)
            await this.addVariable(newName)
        }
    }

    public async updateVariableValue(name: string, value: string) {
        const session = debug.activeDebugSession
        if (session && session.type === 'abap') {
            try {
                const threadsResponse = await session.customRequest('threads')
                if (threadsResponse && threadsResponse.threads && threadsResponse.threads.length > 0) {
                    const threadId = threadsResponse.threads[0].id
                    const stackResponse = await session.customRequest('stackTrace', { threadId: threadId })
                    if (stackResponse && stackResponse.stackFrames && stackResponse.stackFrames.length > 0) {
                        let frameId = stackResponse.stackFrames[0].id
                        // Try to match frame (reuse logic if possible, or just use top frame)
                        const activeEditor = window.activeTextEditor
                        if (activeEditor) {
                            const activeUri = activeEditor.document.uri.toString()
                            const matchedFrame = stackResponse.stackFrames.find((f: any) => {
                                return f.source && f.source.path && activeUri.includes(f.source.path)
                            })
                            if (matchedFrame) {
                                frameId = matchedFrame.id
                            }
                        }

                        await commands.executeCommand('abapfs.debug.setVariable', { name, value, frameId })
                        // Refresh to show new value (and potentially formatted/normalized by backend)
                        await this.evaluateVariable(name)
                    }
                }
            } catch (e) {
                window.showErrorMessage(`Failed to update variable: ${e}`)
            }
        }
    }

    public async addVariable(name: string, autoOpenTable: boolean = false) {
        if (!name) return
        // Focus the view
        commands.executeCommand('abapfs.views.variableTracker.focus')
        this._variables.set(name, { name, value: 'Pending...' })
        this.update()
        await this.evaluateVariable(name)

        if (autoOpenTable) {
            const v = this._variables.get(name)
            if (v && (v.type === 'table' || v.type === 'structure')) {
                this.viewAsTable(name)
            }
        }
    }

    public removeVariable(name: string) {
        this._variables.delete(name)
        this.update()
    }

    public async refreshValues() {
        for (const name of this._variables.keys()) {
            await this.evaluateVariable(name)
        }
    }

    private async viewAsTable(name: string) {
        const info = this._variables.get(name)
        if (info && info.variablesReference) {
            const session = debug.activeDebugSession
            if (session && session.type === 'abap') {
                try {
                    const threadsResponse = await session.customRequest('threads')
                    if (threadsResponse && threadsResponse.threads && threadsResponse.threads.length > 0) {
                        const threadId = threadsResponse.threads[0].id
                        const stackResponse = await session.customRequest('stackTrace', { threadId: threadId })
                        if (stackResponse && stackResponse.stackFrames && stackResponse.stackFrames.length > 0) {
                            const frameId = stackResponse.stackFrames[0].id
                            // Ensure VariableManager.lastCalled is set
                            await session.customRequest('scopes', { frameId: frameId })

                            commands.executeCommand('abapfs.debug.viewAsTable', {
                                container: { variablesReference: info.variablesReference },
                                variable: { name: name }
                            })
                        }
                    }
                } catch (e) {
                    window.showErrorMessage(`Failed to open table view: ${e}`)
                }
            }
        }
    }

    private async evaluateVariable(name: string) {
        const session = debug.activeDebugSession
        if (session && session.type === 'abap') {
            try {
                const threadsResponse = await session.customRequest('threads')
                if (threadsResponse && threadsResponse.threads && threadsResponse.threads.length > 0) {
                    const threadId = threadsResponse.threads[0].id
                    const stackResponse = await session.customRequest('stackTrace', { threadId: threadId })
                    if (stackResponse && stackResponse.stackFrames && stackResponse.stackFrames.length > 0) {
                        // Try to find the frame that matches the active editor
                        let frameId = stackResponse.stackFrames[0].id
                        const activeEditor = window.activeTextEditor
                        if (activeEditor) {
                            const activeUri = activeEditor.document.uri.toString()
                            const matchedFrame = stackResponse.stackFrames.find((f: any) => {
                                // f.source.path might be a path or URI. 
                                // In AbapDebugSession, source path is set to the URI path or similar.
                                // Let's try to match loosely.
                                return f.source && f.source.path && activeUri.includes(f.source.path)
                            })
                            if (matchedFrame) {
                                frameId = matchedFrame.id
                            }
                        }

                        const response = await session.customRequest('evaluate', { expression: name, frameId: frameId })
                        if (response) {
                            this._variables.set(name, {
                                name,
                                value: response.result || 'undefined',
                                type: response.type,
                                variablesReference: response.variablesReference
                            })
                        } else {
                            this._variables.set(name, { name, value: 'undefined' })
                        }
                    } else {
                        this._variables.set(name, { name, value: 'No stack frame found' })
                    }
                } else {
                    this._variables.set(name, { name, value: 'No active thread' })
                }
            } catch (e: any) {
                this._variables.set(name, { name, value: `Error: ${e.message || e}` })
            }
        } else {
            this._variables.set(name, { name, value: 'No active ABAP debug session' })
        }
        this.update()
    }

    private update() {
        if (this._view) {
            this._view.webview.html = this.getHtmlForWebview()
        }
    }

    private getHtmlForWebview() {
        const icons = {
            add: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>`,
            refresh: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M12.9 3.1C11.6 1.8 9.9 1 8 1 4.1 1 1 4.1 1 8s3.1 7 7 7c3.3 0 6.1-2.2 6.8-5.3h-1.5c-.7 2.3-2.8 3.8-5.3 3.8-3 0-5.5-2.5-5.5-5.5S5 2.5 8 2.5c1.7 0 3.2.7 4.3 1.8l-2.8 2.8h5.6V1.5l-2.2 1.6z"/></svg>`,
            view: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M13.5 2h-11C1.67 2 1 2.67 1 3.5v9c0 .83.67 1.5 1.5 1.5h11c.83 0 1.5-.67 1.5-1.5v-9c0-.83-.67-1.5-1.5-1.5zM6 13H2.5v-3H6v3zm0-4H2.5V5H6v4zm7.5 4H7v-3h6.5v3zm0-4H7V5h6.5v4z"/></svg>`,
            remove: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M8 7.293l4.146-4.147.708.708L8.707 8l4.147 4.146-.708.708L8 8.707l-4.146 4.147-.708-.708L7.293 8 3.146 3.854l.708-.708L8 7.293z"/></svg>`
        }

        const rows = Array.from(this._variables.values()).map(v => {
            const isTable = v.type === 'table' || (v.value && v.value.includes('lines'))
            const isStructure = v.type === 'structure'
            const actionBtn = (isTable || isStructure) ? `<button title="View as Table" onclick="viewAsTable('${v.name}')">${icons.view}</button>` : ''

            // Determine if value is editable (simple types)
            // If it's a table or structure, we probably don't want to edit the "value" string directly as it's just a description like "Standard Table..."
            // But for simple types, we want an input.
            const isComplex = isTable || isStructure || v.type === 'objectref' || v.type === 'data' || v.type === 'class'

            let valueCell = ''
            if (isComplex) {
                valueCell = `<td>${v.value}</td>`
            } else {
                valueCell = `<td><input type="text" value="${v.value}" onchange="updateVariableValue('${v.name}', this.value)" style="width:100%; border:none; background:transparent; color:inherit; font-family:inherit;" /></td>`
            }

            return `
            <tr>
                <td><input type="text" value="${v.name}" onchange="updateVariable('${v.name}', this.value)" style="width:100%; border:none; background:transparent; color:inherit; font-family:inherit;" /></td>
                ${valueCell}
                <td>${v.type || ''}</td>
                <td>
                    ${actionBtn}
                    <button title="Remove" onclick="removeVariable('${v.name}')">${icons.remove}</button>
                </td>
            </tr>
        `}).join('')

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { font-family: var(--vscode-editor-font-family); color: var(--vscode-editor-foreground); padding: 10px; }
                table { width: 100%; border-collapse: collapse; }
                td, th { border: 1px solid var(--vscode-panel-border); padding: 5px; text-align: left; }
                input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px; }
                
                button {
                    background: transparent;
                    border: none;
                    color: var(--vscode-icon-foreground);
                    cursor: pointer;
                    padding: 4px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 2px;
                }
                button:hover {
                    background-color: var(--vscode-toolbar-hoverBackground);
                }
                svg {
                    width: 16px;
                    height: 16px;
                    display: block;
                }
                
                .controls { margin-bottom: 10px; display: flex; gap: 5px; align-items: center; }
                #varInput { flex-grow: 1; }
            </style>
            <script>
                const vscode = acquireVsCodeApi();
                function addVariable() {
                    const input = document.getElementById('varInput');
                    const name = input.value;
                    if (name) {
                        vscode.postMessage({ command: 'addVariable', name: name });
                        input.value = '';
                    }
                }
                function removeVariable(name) {
                    vscode.postMessage({ command: 'removeVariable', name: name });
                }
                function viewAsTable(name) {
                    vscode.postMessage({ command: 'viewAsTable', name: name });
                }
                function updateVariable(oldName, newName) {
                    if (oldName !== newName && newName) {
                        vscode.postMessage({ command: 'updateVariable', oldName: oldName, newName: newName });
                    }
                }
                function updateVariableValue(name, value) {
                    vscode.postMessage({ command: 'updateVariableValue', name: name, value: value });
                }
                function refresh() {
                    vscode.postMessage({ command: 'refresh' });
                }
                // Allow Enter key to add variable
                window.onload = function() {
                    document.getElementById('varInput').addEventListener('keypress', function (e) {
                        if (e.key === 'Enter') {
                            addVariable();
                        }
                    });
                }
            </script>
        </head>
        <body>
            <div class="controls">
                <input type="text" id="varInput" placeholder="Enter variable name...">
                <button title="Add Variable" onclick="addVariable()">${icons.add}</button>
                <button title="Refresh Values" onclick="refresh()">${icons.refresh}</button>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Variable</th>
                        <th>Value</th>
                        <th>Type</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        </body>
        </html>`
    }

    private isComment(line: string, index: number): boolean {
        const trimmed = line.trim()
        if (trimmed.startsWith('*')) return true

        let inString = false
        let stringChar = ''

        for (let i = 0; i < index; i++) {
            const char = line[i]
            if (inString) {
                if (char === stringChar) {
                    if (stringChar === "'" && i + 1 < line.length && line[i + 1] === "'") {
                        i++
                    } else {
                        inString = false
                    }
                }
            } else {
                if (char === "'" || char === '|') {
                    inString = true
                    stringChar = char
                } else if (char === '"') {
                    return true
                }
            }
        }
        return false
    }

    private isKeyword(text: string): boolean {
        const keywords = new Set([
            'DATA', 'CONSTANTS', 'TYPES', 'FIELD-SYMBOLS', 'STATICS',
            'IF', 'ELSE', 'ELSEIF', 'ENDIF', 'CASE', 'WHEN', 'ENDCASE',
            'LOOP', 'ENDLOOP', 'WHILE', 'ENDWHILE', 'DO', 'ENDDO',
            'CHECK', 'EXIT', 'RETURN', 'CONTINUE',
            'CALL', 'METHOD', 'FUNCTION', 'PERFORM',
            'SELECT', 'UPDATE', 'INSERT', 'DELETE', 'MODIFY',
            'READ', 'SORT', 'APPEND', 'CLEAR', 'FREE',
            'WRITE', 'MESSAGE',
            'CLASS', 'ENDCLASS', 'INTERFACE', 'ENDINTERFACE',
            'FORM', 'ENDFORM', 'MODULE', 'ENDMODULE',
            'TRY', 'CATCH', 'ENDTRY',
            'INCLUDE', 'TYPE', 'LIKE', 'VALUE', 'INTO', 'ASSIGNING',
            'IS', 'NOT', 'AND', 'OR', 'EQ', 'NE', 'GT', 'LT', 'GE', 'LE'
        ])
        return keywords.has(text.toUpperCase())
    }
}