import { ADTClient, debugMetaIsComplex, DebugMetaType, DebugVariable } from "abap-adt-api"
import { Handles, Scope } from "vscode-debugadapter"
import { DebugProtocol } from "vscode-debugprotocol"
import { DebugListener } from "./debugListener"
import { idThread, STACK_THREAD_MULTIPLIER } from "./debugService"
import { AbapFsCommands, command } from "../../commands"
import { env, window } from "vscode"
import { AbapDebugSession } from "./abapDebugSession"
import { TableViewProvider } from "./tableView"
import { context } from "../../extension"

const pMap = async <T, R>(
    array: T[],
    mapper: (item: T, index: number) => Promise<R>,
    concurrency: number
): Promise<R[]> => {
    const results = new Array<R>(array.length)
    let index = 0
    const next = async (): Promise<void> => {
        while (index < array.length) {
            const i = index++
            results[i] = await mapper(array[i]!, i)
        }
    }
    await Promise.all(Array.from({ length: concurrency }, next))
    return results
}

interface Variable {
    id: string,
    threadId: number,
    name: string,
    meta?: DebugMetaType,
    lines?: number
}

const variableValue = (v: DebugVariable) => {
    if (v.META_TYPE === "table") return `${v.TECHNICAL_TYPE || v.META_TYPE} ${v.TABLE_LINES} lines`
    if (v.META_TYPE === "objectref") return v.VALUE
    if (debugMetaIsComplex(v.META_TYPE)) return v.META_TYPE
    return `${v.VALUE}`
}

const isDebugVariable = (v: DebugVariable | { id: string; name: string }): v is DebugVariable => "ID" in v

export class VariableManager {
    private handles = new Map<number, Handles<Variable>>()// will be overwritten at first use
    private currentStackId = 0
    private static lastCalled: VariableManager | undefined

    private variableHandles(threadId: number) {
        const handle = this.handles.get(threadId)
        if (handle) return handle
        return this.resetHandle(threadId)
    }
    public resetHandle(threadId: number) {
        const handle = new Handles<Variable>(STACK_THREAD_MULTIPLIER * threadId)
        this.handles.set(threadId, handle)
        return handle
    }

    private client(threadId: number) {
        try {
            return this.listener.service(threadId).client
        } catch (error) {/* */ }
    }
    private stackTrace(threadId: number) {
        return this.listener.service(threadId).stackTrace
    }
    constructor(private readonly listener: DebugListener) { }
    createVariable(threadId: number, v: DebugVariable | { id: string, name: string }) {
        if (isDebugVariable(v))
            return this.variableHandles(threadId).create({ id: v.ID, name: v.NAME, lines: v.TABLE_LINES, meta: v.META_TYPE, threadId })
        return this.variableHandles(threadId).create({ id: v.id, name: v.name, threadId })
    }
    async getScopes(frameId: number) {
        const threadId = idThread(frameId)
        const client = this.client(threadId)
        if (!client) return []
        VariableManager.lastCalled = this
        const currentStack = this.stackTrace(threadId).find(s => s.id === frameId)
        if (currentStack && !isNaN(currentStack.stackPosition) && frameId !== this.currentStackId) {
            await client.debuggerGoToStack(currentStack.stackUri || currentStack.stackPosition)
            this.currentStackId = frameId
        }
        const { hierarchies } = await client.debuggerChildVariables(["@ROOT"])
        const scopes = hierarchies.map(h => {
            const name = h.CHILD_NAME || h.CHILD_ID
            const handler = this.createVariable(threadId, { id: h.CHILD_ID, name })
            return new Scope(name, handler, true)
        })
        const syhandler = this.createVariable(threadId, { id: "SY", name: "SY" })
        scopes.push(new Scope("SY", syhandler, true))
        return scopes
    }

    private async childVariables(parent: Variable) {
        const client = this.client(parent.threadId)
        if (!client) return []
        if (parent.meta === "table") {
            if (!parent.lines) return []
            const keys = [...Array(parent.lines).keys()].map(k => `${parent.id.replace(/\[\]$/, "")}[${k + 1}]`)
            return client.debuggerVariables(keys)
        }
        return client.debuggerChildVariables([parent.id]).then(r => r.variables)
    }
    async fetchTableSlice(client: ADTClient, v: DebugVariable, start: number, count: number) {
        if (v.META_TYPE !== "table") return []
        const end = Math.min(start + count, v.TABLE_LINES)
        if (start >= end) return []

        const firstRowKey = `${v.ID}[${start + 1}]`
        const firstRow = await client.debuggerVariables([firstRowKey]).then(r => r[0])
        if (!firstRow) return []

        if (firstRow.META_TYPE === 'structure') {
            const children = await client.debuggerChildVariables([firstRow.ID]).then(r => r.variables)
            const fields = children.map(c => ({ name: c.NAME, suffix: c.ID.slice(firstRow.ID.length) }))

            const allKeys: string[] = []
            for (let i = start; i < end; i++) {
                const rowId = `${v.ID}[${i + 1}]`
                for (const f of fields) {
                    allKeys.push(rowId + f.suffix)
                }
            }

            const chunkSize = 200
            const chunks = []
            for (let i = 0; i < allKeys.length; i += chunkSize) {
                chunks.push(allKeys.slice(i, i + chunkSize))
            }

            const results = await pMap(chunks, keys => client.debuggerVariables(keys), 5)
            const flatResults = results.flat()
            const resultMap = new Map(flatResults.map(v => [v.ID, v]))

            const rows = []
            for (let i = start; i < end; i++) {
                const rowId = `${v.ID}[${i + 1}]`
                const rowObj: any = {}
                for (const f of fields) {
                    const val = resultMap.get(rowId + f.suffix)
                    rowObj[f.name] = val ? variableValue(val) : ""
                }
                rows.push(rowObj)
            }
            return rows
        } else {
            const keys = []
            for (let i = start; i < end; i++) {
                keys.push(`${v.ID}[${i + 1}]`)
            }
            const linevars = await client.debuggerVariables(keys)
            return linevars.map(lv => ({ "VALUE": variableValue(lv) }))
        }
    }
    async dumpJson(client: ADTClient, name: string | DebugVariable) {
        const v = typeof name !== "string" ? name : await client.debuggerVariables([name]).then(v => v[0])
        if (!v) return
        switch (v.META_TYPE) {
            case "simple":
                if (v.TECHNICAL_TYPE.match(/B|S|I|INT8|P|N|DECFLOAT16|DECFLOAT34|F/)) return Number(v.VALUE)
                return v.VALUE.trimEnd()
            case "string":
                return v.VALUE.trimEnd()
            case "structure":
                const comps = await client.debuggerChildVariables([v.ID]).then(r => r.variables)
                const str: any = {}
                for (const comp of comps) {
                    const cv = await this.dumpJson(client, comp)
                    str[comp.NAME] = cv
                }
                return str
            case "table":
                const outlines: any[] = []
                const keys = [...Array(v.TABLE_LINES).keys()].map(k => `${v.ID}[${k + 1}]`)
                const linevars = await client.debuggerVariables(keys)
                for (const lv of linevars) {
                    const line = await this.dumpJson(client, lv)
                    outlines.push(line)
                }
                return outlines
            case "unknown":
            case "dataref":
            case "boxedcomp":
            case "anonymcomp":
            case "objectref":
            case "class":
            case "object":
            case "boxref":
            case "anonymcomp":
                return `Unprocessable:${v.META_TYPE}`
        }
    }

    private static currentClient(variablesReference: number): [VariableManager, ADTClient] | undefined {
        const vm = VariableManager.lastCalled
        if (!vm) return
        const threadId = idThread(variablesReference)
        const client = vm.client(threadId)
        if (!client) return
        return [vm, client]
    }

    @command(AbapFsCommands.setVariable)
    private static async setVariableCmd(arg: { name: string, value: string, frameId?: number }) {
        const vm = VariableManager.lastCalled
        if (!vm) {
            window.showErrorMessage("No active debug session detected")
            return
        }

        // If frameId is provided, use it to find thread. Otherwise try to guess or use default.
        // VariableTracker passes frameId if available.
        let threadId: number | undefined
        if (arg.frameId) {
            threadId = idThread(arg.frameId)
        } else {
            // Fallback: try to find any active thread?
            // For now, assume lastCalled has some context or we fail.
            // We can try to get the first thread from handles if we tracked them?
            // But handles are per thread.
            // Let's rely on frameId being passed or fail.
        }

        if (!threadId) {
            // Try to get from active session if possible?
            // But we need the client.
            // If vm.handles has keys, we can pick one?
            // vm.handles is private.
            // Let's assume frameId is passed.
            // If not, we can try to use the threadId from the last 'getScopes' call if we stored it?
            // But 'getScopes' stores 'currentStackId'.
            if (vm.currentStackId) {
                threadId = idThread(vm.currentStackId)
            }
        }

        if (!threadId) {
            window.showErrorMessage("Cannot determine debug thread")
            return
        }

        const client = vm.client(threadId)
        if (!client) {
            window.showErrorMessage("No active client for thread")
            return
        }

        try {
            await client.debuggerSetVariableValue(arg.name, arg.value)
        } catch (e) {
            window.showErrorMessage(`Failed to set variable: ${e}`)
        }
    }

    @command(AbapFsCommands.exportToJson)
    private static async exportJson(arg: { container: { variablesReference: number }, variable: { name: string } }) {
        const [vm, client] = this.currentClient(arg.container.variablesReference) || []
        if (!vm || !client) {
            window.showErrorMessage("No active debug session detected")
            return
        }
        if (AbapDebugSession.activeSessions > 1) window.showWarningMessage("Multiple debug session detected. might export from wrong one")
        const json = await vm.dumpJson(client, arg.variable.name)
        env.clipboard.writeText(JSON.stringify(json, null, 1))

    }
    @command(AbapFsCommands.viewAsTable)
    private static async viewAsTable(arg: { container: { variablesReference: number }, variable: { name: string } }) {
        const [vm, client] = this.currentClient(arg.container.variablesReference) || []
        if (!vm || !client) {
            window.showErrorMessage("No active debug session detected")
            return
        }

        try {
            const v = await client.debuggerVariables([arg.variable.name]).then(r => r[0])
            if (!v) return

            let data: any
            let total = 0

            if (v.META_TYPE === 'table') {
                total = v.TABLE_LINES
                data = await vm.fetchTableSlice(client, v, 0, 100)
            } else {
                data = await vm.dumpJson(client, v)
                if (v.META_TYPE === 'structure' && data && !Array.isArray(data)) {
                    data = [data]
                }
                if (Array.isArray(data)) total = data.length
            }

            if (Array.isArray(data)) {
                const controller = {
                    onEdit: async (row: number, name: string, value: string) => {
                        let varName = ""
                        if (v.META_TYPE === 'structure') {
                            varName = `${v.ID}-${name}`
                        } else if (v.META_TYPE === 'table') {
                            const isTableOfStructures = await client.debuggerVariables([`${v.ID}[1]`]).then(r => r[0]?.META_TYPE === 'structure')
                            if (isTableOfStructures) {
                                // row is 0-based absolute index from the view. ABAP is 1-based.
                                varName = `${v.ID}[${row + 1}]-${name}`
                            } else {
                                varName = `${v.ID}[${row + 1}]`
                            }
                        } else {
                            window.showErrorMessage("Cannot edit this variable type")
                            return false
                        }

                        try {
                            await client.debuggerSetVariableValue(varName, value)
                            return true
                        } catch (e) {
                            window.showErrorMessage(`Failed to set value: ${e}`)
                            return false
                        }
                    },
                    onRequestPage: async (start: number, limit: number) => {
                        try {
                            let newData: any
                            let newTotal = 0
                            if (v.META_TYPE === 'table') {
                                // Re-fetch variable to get updated line count?
                                const newV = await client.debuggerVariables([arg.variable.name]).then(r => r[0])
                                if (newV) {
                                    newTotal = newV.TABLE_LINES
                                    newData = await vm.fetchTableSlice(client, newV, start, limit)
                                }
                            } else {
                                // For non-tables (arrays), we dump everything anyway?
                                // Or should we slice the array?
                                // dumpJson returns all.
                                // We can slice it here.
                                const newV = await client.debuggerVariables([arg.variable.name]).then(r => r[0])
                                if (newV) {
                                    const allData = await vm.dumpJson(client, newV)
                                    if (Array.isArray(allData)) {
                                        newTotal = allData.length
                                        newData = allData.slice(start, start + limit)
                                    }
                                }
                            }
                            if (newData) {
                                TableViewProvider.instance.show(arg.variable.name, newData, newTotal, start, limit, controller)
                            }
                        } catch (e) {
                            window.showErrorMessage(`Error fetching page: ${e}`)
                        }
                    }
                }
                TableViewProvider.instance.show(arg.variable.name, data, total, 0, 100, controller)
            } else {
                window.showInformationMessage("Variable is not a table or array")
            }
        } catch (e) {
            window.showErrorMessage(`Error fetching table data: ${e}`)
        }
    }
    async evaluate(expression: string, frameId?: number): Promise<DebugProtocol.EvaluateResponse["body"] | undefined> {
        try {
            const threadId = frameId && idThread(frameId)
            if (!threadId) throw new Error("No thread id")
            const client = this.client(threadId)
            if (!client) throw new Error("No client")
            const jse = expression.match(/^json\((.*)\)\s*$/)
            if (jse?.[1]) {
                const json = await this.dumpJson(client, jse[1])
                return { result: JSON.stringify(json, null, 1), variablesReference: 0 }
            }
            const v = await client.debuggerVariables([expression])
            if (!v[0]) return { result: "undefined", variablesReference: 0 }
            return {
                result: variableValue(v[0]),
                variablesReference: this.variableReference(v[0], threadId),
                type: v[0].META_TYPE
            }
        } catch (error: any) {
            const msg = error?.message || error?.properties?.conflictText || "Error evaluating variable"
            throw new Error(msg)
        }
    }

    private variableReference(v: DebugVariable, threadId: number) {
        return debugMetaIsComplex(v.META_TYPE) ? this.createVariable(threadId, v) : 0
    }

    async getVariables(parentid: number) {
        const threadId = idThread(parentid)
        const vari = this.variableHandles(threadId).get(parentid)
        if (vari) {
            const children = await this.childVariables(vari)
            const variables: DebugProtocol.Variable[] = children.map(v => ({
                name: `${v.NAME}`,
                value: variableValue(v),
                variablesReference: this.variableReference(v, vari.threadId),
                memoryReference: `${v.ID}`,
                evaluateName: `${v.ID}`,
                __vscodeVariableMenuContext: v.META_TYPE
            } as any))
            return variables
        }
        return []
    }


    async setVariable(reference: number, name: string, inputValue: string) {
        try {
            const threadId = idThread(reference)
            const client = this.client(threadId)
            if (!client) return { value: "", success: false }
            const h = this.variableHandles(threadId).get(reference)
            const variable = h.id.match(/^@/) ? name : `${h?.name}-${name}`.toUpperCase()
            const value = await client.debuggerSetVariableValue(variable, inputValue)
            return { value, success: true }
        } catch (error) {
            return { value: "", success: false }
        }
    }


}