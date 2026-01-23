import { DecorationOptions, ExtensionContext, Position, Range, window, workspace } from "vscode"
import { atcProvider } from "."
import { AtcFind, hasExemption } from "./view"
let timeout: NodeJS.Timeout | undefined

const empty = window.createTextEditorDecorationType({})
const decorators = {
    error: empty,
    warning: empty,
    info: empty,
    exempted: empty
}


const toDecoration = (m: AtcFind): DecorationOptions =>
    ({ range: new Range(m.start, m.start), hoverMessage: m.finding.messageTitle })

const fileFindings = new Map<string, AtcFind[]>()

// Categorized decorations structure for single-pass processing
interface CategorizedDecorations {
    exempt: DecorationOptions[]
    infos: DecorationOptions[]
    warnings: DecorationOptions[]
    errors: DecorationOptions[]
}

/**
 * Categorize markers in a single pass for better performance
 * Instead of 4 separate filter/map operations
 */
function categorizeMarkers(markers: AtcFind[]): CategorizedDecorations {
    const result: CategorizedDecorations = {
        exempt: [],
        infos: [],
        warnings: [],
        errors: []
    }

    for (const m of markers) {
        const decoration = toDecoration(m)
        if (hasExemption(m.finding)) {
            result.exempt.push(decoration)
        } else if (m.finding.priority === 1) {
            result.errors.push(decoration)
        } else if (m.finding.priority === 2) {
            result.warnings.push(decoration)
        } else {
            result.infos.push(decoration)
        }
    }

    return result
}

function updateDecorations() {
    const editor = window.activeTextEditor
    if (!editor) return

    const markers = fileFindings.get(editor.document.uri.toString()) || []
    const { exempt, infos, warnings, errors } = categorizeMarkers(markers)

    editor.setDecorations(decorators.exempted, exempt)
    editor.setDecorations(decorators.info, infos)
    editor.setDecorations(decorators.warning, warnings)
    editor.setDecorations(decorators.error, errors)
}

export function triggerUpdateDecorations() {
    if (timeout) {
        clearTimeout(timeout)
        timeout = undefined
    }
    timeout = setTimeout(updateDecorations, 100)
}

export function registerSCIDecorator(context: ExtensionContext) {
    const decoratorConfig = {
        light: {
            gutterIconPath: context.asAbsolutePath("client/images/light/issues.svg"),
            backgroundColor: "lightblue",
        },
        dark: {
            gutterIconPath: context.asAbsolutePath("client/images/dark/issues.svg"),
            backgroundColor: "darkblue",
        },
        isWholeLine: true
    }
    decorators.info = window.createTextEditorDecorationType(decoratorConfig)
    decoratorConfig.light.backgroundColor = "#f0f000"
    decoratorConfig.dark.backgroundColor = "#404000"
    decorators.warning = window.createTextEditorDecorationType(decoratorConfig)
    decoratorConfig.light.backgroundColor = "lightred"
    decoratorConfig.dark.backgroundColor = "darkred"
    decorators.error = window.createTextEditorDecorationType(decoratorConfig)
    decoratorConfig.light.backgroundColor = "lightgreen"
    decoratorConfig.dark.backgroundColor = "darkgreen"
    decorators.exempted = window.createTextEditorDecorationType(decoratorConfig)

    workspace.onDidChangeTextDocument(event => {
        if (window.activeTextEditor && event.document === window.activeTextEditor.document) {
            for (const finding of fileFindings.get(event.document.uri.toString()) || []) {
                finding.applyEdits(event.contentChanges)
            }
        }
    }, null, context.subscriptions)

    workspace.onDidSaveTextDocument(event => {
        for (const finding of fileFindings.get(event.uri.toString()) || []) finding.savePosition()

    }, null, context.subscriptions)
    workspace.onDidCloseTextDocument(event => {
        for (const finding of fileFindings.get(event.uri.toString()) || []) finding.cancelEdits()

    }, null, context.subscriptions)

    window.onDidChangeActiveTextEditor(() => {
        if (window.activeTextEditor) triggerUpdateDecorations()
    }, null, context.subscriptions)
    atcProvider.onDidChangeTreeData(() => {
        const findings = atcProvider.findings()
        fileFindings.clear()
        for (const finding of findings) {
            const current = fileFindings.get(finding.uri)
            if (current) current.push(finding)
            else fileFindings.set(finding.uri, [finding])
        }
        triggerUpdateDecorations()
    })
}

