import { ADTClient, debugMetaIsComplex, DebugMetaType, DebugVariable } from "abap-adt-api"
import { Handles, Scope } from "vscode-debugadapter"
import { DebugProtocol } from "vscode-debugprotocol"
import { DebugListener } from "./debugListener"
import { idThread, STACK_THREAD_MULTIPLIER } from "./debugService"
import { AbapFsCommands, command } from "../../commands"
import { env, window } from "vscode"
import { AbapDebugSession } from "./abapDebugSession"
import { TableView } from "./tableView"
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
                if (Array.isArray(data)) total = data.length
            }

            if (Array.isArray(data)) {
                TableView.createOrShow(context, arg.variable.name, data, total)
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
            if (!threadId) return
            const client = this.client(threadId)
            if (!client) return
            const jse = expression.match(/^json\((.*)\)\s*$/)
            if (jse?.[1]) {
                const json = await this.dumpJson(client, jse[1])
                return { result: JSON.stringify(json, null, 1), variablesReference: 0 }
            }
            const v = await client.debuggerVariables([expression])
            if (!v[0]) return
            return { result: variableValue(v[0]), variablesReference: this.variableReference(v[0], threadId) }
        } catch (error) {
            return
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
                evaluateName: `${v.ID}`
            }))
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