import {
    window,
    Disposable,
    Uri,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    EventEmitter
} from "vscode"
import { AbapObject } from "abapobject"
import { uriAbapFile } from "../adt/operations/AdtObjectFinder"
import { ADTSCHEME } from "../adt/conections"
import { AbapFsCommands } from "../commands/registry"

export class PropertyItem extends TreeItem {
    constructor(
        public readonly label: string,
        public readonly value: string,
        public readonly description?: string,
        public readonly isTransport?: boolean
    ) {
        super(label, TreeItemCollapsibleState.None)
        this.description = value
        this.tooltip = description || value
        if (isTransport) {
            this.command = {
                command: AbapFsCommands.revealTransport,
                title: "Reveal Transport",
                arguments: [value]
            }
        }
    }
}

export class ObjectPropertiesProvider implements TreeDataProvider<PropertyItem>, Disposable {
    private currentObject?: AbapObject
    private disposables: Disposable[] = []
    private _onDidChangeTreeData = new EventEmitter<PropertyItem | undefined | null | void>()
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event
    private properties: PropertyItem[] = []

    constructor() {
        this.disposables.push(window.onDidChangeActiveTextEditor(editor => {
            this.refresh(editor?.document.uri)
        }))
        if (window.activeTextEditor) {
            this.refresh(window.activeTextEditor.document.uri)
        }
    }

    getTreeItem(element: PropertyItem): TreeItem {
        return element
    }

    getChildren(element?: PropertyItem): PropertyItem[] {
        if (element) return []
        return this.properties
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
        this.properties = []
        if (this.currentObject) {
            const obj = this.currentObject
            this.properties.push(new PropertyItem("Name", obj.name))
            this.properties.push(new PropertyItem("Type", obj.type))

            if (obj.structure?.metaData) {
                const md = obj.structure.metaData as any
                const addProperty = (label: string, val: any) => {
                    if (val) this.properties.push(new PropertyItem(label, val))
                }
                if (md["adtcore:description"]) addProperty("Description", md["adtcore:description"])
                if (md["adtcore:packageName"]) addProperty("Package", md["adtcore:packageName"])
                if (md["adtcore:responsible"]) addProperty("Created By", md["adtcore:responsible"])
                if (md["adtcore:createdAt"]) addProperty("Created At", new Date(md["adtcore:createdAt"]).toLocaleString())
                if (md["adtcore:changedBy"]) addProperty("Changed By", md["adtcore:changedBy"])
                if (md["adtcore:changedAt"]) addProperty("Changed At", new Date(md["adtcore:changedAt"]).toLocaleString())
                if (md["adtcore:version"]) addProperty("Version", md["adtcore:version"])
                if (md["adtcore:masterLanguage"]) addProperty("Master Language", md["adtcore:masterLanguage"])
                // try to detect transport/request numbers in metadata
                const transportKeys = Object.keys(md).filter(k => k.toLowerCase().includes("transport"))
                for (const k of transportKeys) {
                    const val = md[k]
                    if (!val) continue
                    // if a single transport string or array
                    if (Array.isArray(val)) {
                        val.forEach(t => this.properties.push(new PropertyItem("Transport", t, undefined, true)))
                    } else if (typeof val === "string") {
                        this.properties.push(new PropertyItem("Transport", val, undefined, true))
                    }
                }
                // also check links for potential transport-related relations
                if (obj.structure.links) {
                    const tlinks = (obj.structure.links as any[]).filter(l => l.rel && l.rel.toLowerCase().includes("transport"))
                    if (tlinks.length) {
                        tlinks.forEach(l => this.properties.push(new PropertyItem("Transport Link", l.href, undefined, true)))
                    }
                }
            }
        }
        this._onDidChangeTreeData.fire()
    }

    dispose() {
        this.disposables.forEach(d => d.dispose())
    }
}

export const objectPropertiesProvider = new ObjectPropertiesProvider()
