import {
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    Uri,
    EventEmitter,
    window,
    commands,
    Disposable,
    ThemeIcon,
    TreeView,
    TreeItemCheckboxState,
    TreeCheckboxChangeEvent,
    MarkdownString
} from "vscode"
import { AbapObject } from "abapobject"
import { uriAbapFile } from "../adt/operations/AdtObjectFinder"
import { ADTSCHEME } from "../adt/conections"
import { AbapRevisionService, revLabel } from "../scm/abaprevisions/abaprevisionservice"
import { Revision } from "abap-adt-api"
import { AbapQuickDiff } from "../scm/abaprevisions/quickdiff"
import { revisionUri } from "../scm/abaprevisions/documentprovider"
import { displayRevDiff } from "../scm/abaprevisions/commands"
import { AbapFsCommands } from "../commands/registry"

export class RevisionItem extends TreeItem {
    constructor(
        public readonly revision: Revision,
        public readonly uri: Uri,
        isChecked: boolean = false
    ) {
        const code = revision.version || "";
        const name = revision.versionTitle || "";
        const label = name || code || "Unknown";
        super(label, TreeItemCollapsibleState.None)
        
        const parts: string[] = [];
        if (code && code !== label) parts.push(code);
        if (revision.author) parts.push(revision.author);
        if (revision.date) parts.push(revision.date);
        
        this.description = parts.join(" • ");
        
        const md = new MarkdownString();
        md.appendMarkdown(`**${name}**\n\n`);
        md.appendMarkdown(`- **Version:** ${code}\n`);
        md.appendMarkdown(`- **Author:** ${revision.author}\n`);
        md.appendMarkdown(`- **Date:** ${revision.date}\n`);
        this.tooltip = md;

        this.contextValue = "abapfs:revision"
        this.iconPath = new ThemeIcon("git-commit")
        this.checkboxState = isChecked ? TreeItemCheckboxState.Checked : TreeItemCheckboxState.Unchecked
        this.command = {
            command: "abapfs.history.open",
            title: "Open Revision",
            arguments: [this]
        }
    }
}

export class ObjectHistoryProvider implements TreeDataProvider<RevisionItem>, Disposable {
    private _onDidChangeTreeData = new EventEmitter<RevisionItem | undefined | null | void>()
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event

    private currentObject?: AbapObject
    private currentUri?: Uri
    private revisions: Revision[] = []
    private connId?: string
    private disposables: Disposable[] = []
    private treeView?: TreeView<RevisionItem>
    private checkedRevisions = new Set<string>()

    public setTreeView(view: TreeView<RevisionItem>) {
        this.treeView = view
        this.disposables.push(view.onDidChangeCheckboxState(e => this.onCheckboxChange(e)))
    }

    constructor() {
        this.disposables.push(window.onDidChangeActiveTextEditor(editor => {
            this.refresh(editor?.document.uri)
        }))
        if (window.activeTextEditor) {
            this.refresh(window.activeTextEditor.document.uri)
        }
    }

    private onCheckboxChange(e: TreeCheckboxChangeEvent<RevisionItem>) {
        for (const [item, state] of e.items) {
            if (item.revision.uri) {
                if (state === TreeItemCheckboxState.Checked) {
                    this.checkedRevisions.add(item.revision.uri)
                } else {
                    this.checkedRevisions.delete(item.revision.uri)
                }
            }
        }
    }

    getTreeItem(element: RevisionItem): TreeItem {
        return element
    }

    async getChildren(element?: RevisionItem): Promise<RevisionItem[]> {
        if (element) return []
        return this.revisions.map(r => new RevisionItem(r, this.currentUri!, this.checkedRevisions.has(r.uri)))
    }

    private async refresh(uri?: Uri) {
        this.revisions = []
        this.checkedRevisions.clear()
        if (uri && uri.scheme === ADTSCHEME) {
            this.currentUri = uri
            const file = uriAbapFile(uri)
            if (file) {
                this.currentObject = file.object
                this.connId = uri.authority
                try {
                    if (this.connId)
                        this.revisions = await AbapRevisionService.get(this.connId).objRevisions(this.currentObject)
                } catch (e) {
                    // ignore error
                }
            }
        }
        this._onDidChangeTreeData.fire()
    }

    dispose() {
        this.disposables.forEach(d => d.dispose())
    }

    // Commands
    public async openRevision(item: RevisionItem) {
        const uri = revisionUri(item.uri, item.revision)
        if (uri) await commands.executeCommand("vscode.open", uri)
    }

    public async setQuickDiff(item: RevisionItem) {
        AbapQuickDiff.get().setCurrentRev(item.uri, item.revision)
    }

    public async compareWithCurrent(item: RevisionItem) {
        displayRevDiff(undefined, item.revision, item.uri)
    }

    public async compareSelected() {
        const checked = this.revisions.filter(r => this.checkedRevisions.has(r.uri))
        
        if (checked.length !== 2) {
            window.showErrorMessage("Please select exactly 2 revisions to compare")
            return
        }
        const [r1, r2] = checked
        if (!r1 || !r2) return
        const d1 = new Date(r1.date).getTime()
        const d2 = new Date(r2.date).getTime()
        if (d1 < d2) displayRevDiff(r2, r1, this.currentUri!)
        else displayRevDiff(r1, r2, this.currentUri!)
    }
    
    public async openTransport(item: RevisionItem) {
        const match = item.revision.versionTitle?.match(/Transport\s+([A-Z0-9]+)/i)
        if (match) {
            const transport = match[1]
            await commands.executeCommand(AbapFsCommands.revealTransport, transport)
        } else {
            window.showInformationMessage("No transport number found in revision details")
        }
    }
}

export const objectHistoryProvider = new ObjectHistoryProvider()
