import {
    TreeDataProvider,
    TreeItem,
    Event,
    EventEmitter,
    window,
    Disposable,
    TreeItemCollapsibleState,
    Uri
} from "vscode"
import { AbapObject } from "abapobject"
import { uriAbapFile } from "../adt/operations/AdtObjectFinder"
import { ADTSCHEME } from "../adt/conections"

class PropertyItem extends TreeItem {
    constructor(key: string, value: string) {
        super(key, TreeItemCollapsibleState.None)
        this.description = value
        this.tooltip = `${key}: ${value}`
    }
}

export class ObjectPropertiesProvider implements TreeDataProvider<PropertyItem>, Disposable {
    private _onDidChangeTreeData: EventEmitter<PropertyItem | undefined | null | void> = new EventEmitter<PropertyItem | undefined | null | void>()
    readonly onDidChangeTreeData: Event<PropertyItem | undefined | null | void> = this._onDidChangeTreeData.event

    private currentObject?: AbapObject
    private disposables: Disposable[] = []

    constructor() {
        this.disposables.push(window.onDidChangeActiveTextEditor(editor => {
            this.refresh(editor?.document.uri)
        }))
        if (window.activeTextEditor) {
            this.refresh(window.activeTextEditor.document.uri)
        }
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
        this._onDidChangeTreeData.fire()
    }

    getTreeItem(element: PropertyItem): TreeItem {
        return element
    }

    getChildren(element?: PropertyItem): PropertyItem[] {
        if (element) {
            return []
        }

        if (!this.currentObject) {
            return [new PropertyItem("No active ABAP object", "")]
        }

        const obj = this.currentObject
        const items: PropertyItem[] = []

        items.push(new PropertyItem("Name", obj.name))
        items.push(new PropertyItem("Type", obj.type))

        if (obj.structure?.metaData) {
            const md = obj.structure.metaData as any
            if (md["adtcore:description"]) items.push(new PropertyItem("Description", md["adtcore:description"]))
            if (md["adtcore:packageName"]) items.push(new PropertyItem("Package", md["adtcore:packageName"]))
            if (md["adtcore:responsible"]) items.push(new PropertyItem("Created By", md["adtcore:responsible"]))
            if (md["adtcore:createdAt"]) items.push(new PropertyItem("Created At", new Date(md["adtcore:createdAt"]).toLocaleString()))
            if (md["adtcore:changedBy"]) items.push(new PropertyItem("Changed By", md["adtcore:changedBy"]))
            if (md["adtcore:changedAt"]) items.push(new PropertyItem("Changed At", new Date(md["adtcore:changedAt"]).toLocaleString()))
            if (md["adtcore:version"]) items.push(new PropertyItem("Version", md["adtcore:version"]))
            if (md["adtcore:masterLanguage"]) items.push(new PropertyItem("Master Language", md["adtcore:masterLanguage"]))
        }

        return items
    }

    dispose() {
        this.disposables.forEach(d => d.dispose())
    }
}

export const objectPropertiesProvider = new ObjectPropertiesProvider()
