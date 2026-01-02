import {
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    Uri,
    EventEmitter,
    window,
    Disposable,
    ThemeIcon,
    TreeView,
    MarkdownString,
    commands,
    Selection,
    Position,
    workspace
} from "vscode"
import { AbapObject } from "abapobject"
import { uriAbapFile, createUri } from "../adt/operations/AdtObjectFinder"
import { ADTSCHEME, uriRoot } from "../adt/conections"
import { IncludeService } from "../adt/includes/service"
import { NodeStructure, Node } from "abap-adt-api"
import { isAbapStat, Root, isAbapFolder, isAbapFile, AbapFolder } from "abapfs"

// Item type for tree hierarchy
type ObjectListItemType = "mainProgram" | "include" | "component" | "category" | "symbol"

// Symbol info for FORMs/MODULEs/METHODs
interface SymbolInfo {
    name: string
    type: "FORM" | "MODULE" | "METHOD"
    line: number
}

export class ObjectListItem extends TreeItem {
    public line?: number  // Line number for navigation
    
    constructor(
        public readonly itemType: ObjectListItemType,
        public readonly label: string,
        public readonly uri?: Uri,
        public readonly adtUri?: string,
        public readonly objectType?: string,
        public readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
        public readonly children: ObjectListItem[] = [],
        public readonly lineNumber?: number  // Line number for symbol navigation
    ) {
        super(label, collapsibleState)
        this.contextValue = `abapfs:objectList:${itemType}`
        this.line = lineNumber

        // Set icons based on type
        switch (itemType) {
            case "mainProgram":
                this.iconPath = new ThemeIcon("symbol-file")
                this.description = "Main Program"
                break
            case "include":
                this.iconPath = new ThemeIcon("file-code")
                this.description = objectType || "Include"
                break
            case "component":
                this.iconPath = this.getIconForType(objectType)
                this.description = objectType
                break
            case "category":
                this.iconPath = new ThemeIcon("folder")
                break
            case "symbol":
                this.iconPath = this.getIconForSymbolType(objectType)
                this.description = objectType
                break
        }

        // Make items clickable if they have a URI
        if (uri && itemType !== "category") {
            if (lineNumber !== undefined) {
                // Navigate to specific line - use vscode.open with selection
                const selection = new Selection(lineNumber, 0, lineNumber, 0)
                this.command = {
                    command: "vscode.open",
                    title: "Open at line",
                    arguments: [uri, { selection }]
                }
            } else {
                this.command = {
                    command: "vscode.open",
                    title: "Open",
                    arguments: [uri]
                }
            }
        }

        // Add tooltip
        const tooltipMd = new MarkdownString()
        tooltipMd.appendMarkdown(`**${label}**\n\n`)
        if (objectType) tooltipMd.appendMarkdown(`Type: ${objectType}\n`)
        if (lineNumber !== undefined) tooltipMd.appendMarkdown(`Line: ${lineNumber + 1}\n`)
        if (adtUri) tooltipMd.appendMarkdown(`\nPath: ${adtUri}`)
        this.tooltip = tooltipMd
    }

    private getIconForSymbolType(type?: string): ThemeIcon {
        if (!type) return new ThemeIcon("symbol-method")
        const typeUpper = type.toUpperCase()
        if (typeUpper === "FORM") return new ThemeIcon("symbol-function")
        if (typeUpper === "MODULE") return new ThemeIcon("symbol-event")
        if (typeUpper === "METHOD") return new ThemeIcon("symbol-method")
        return new ThemeIcon("symbol-method")
    }

    private getIconForType(type?: string): ThemeIcon {
        if (!type) return new ThemeIcon("file")
        const typeUpper = type.toUpperCase()
        if (typeUpper.includes("CLAS")) return new ThemeIcon("symbol-class")
        if (typeUpper.includes("INTF")) return new ThemeIcon("symbol-interface")
        if (typeUpper.includes("METH")) return new ThemeIcon("symbol-method")
        if (typeUpper.includes("FUNC")) return new ThemeIcon("symbol-function")
        if (typeUpper.includes("PROG")) return new ThemeIcon("file-code")
        if (typeUpper.includes("INCL") || typeUpper === "PROG/I") return new ThemeIcon("file-submodule")
        if (typeUpper.includes("FORM")) return new ThemeIcon("symbol-event")
        if (typeUpper.includes("DEVC") || typeUpper.includes("PACK")) return new ThemeIcon("package")
        if (typeUpper.includes("TABL") || typeUpper.includes("VIEW")) return new ThemeIcon("database")
        if (typeUpper.includes("DTEL") || typeUpper.includes("DOMA")) return new ThemeIcon("symbol-field")
        if (typeUpper.includes("FUGR")) return new ThemeIcon("symbol-namespace")
        return new ThemeIcon("file")
    }
}

export class ObjectListProvider implements TreeDataProvider<ObjectListItem>, Disposable {
    private _onDidChangeTreeData = new EventEmitter<ObjectListItem | undefined | null | void>()
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event

    private currentObject?: AbapObject
    private currentUri?: Uri
    private connId?: string
    private disposables: Disposable[] = []
    private treeView?: TreeView<ObjectListItem>
    private cachedItems: ObjectListItem[] = []
    private isLoading = false
    
    // Cache to avoid re-fetching when main program is the same
    private cachedMainProgramName?: string
    private cachedMainProgramUri?: string
    private componentsCache = new Map<string, NodeStructure>()
    private uriCache = new Map<string, string | null>()  // adtPath -> fsPath (null = not found)
    private fileToMainCache = new Map<string, string>()  // filePath -> mainProgramUri (for instant lookup)

    constructor() {
        this.disposables.push(window.onDidChangeActiveTextEditor(editor => {
            this.refresh(editor?.document.uri)
        }))
        if (window.activeTextEditor) {
            this.refresh(window.activeTextEditor.document.uri)
        }
    }

    public setTreeView(view: TreeView<ObjectListItem>) {
        this.treeView = view
    }

    /** Collapse all items in the tree */
    public async collapseAll() {
        if (!this.treeView) return
        // Use VS Code's built-in command to collapse all
        await commands.executeCommand("workbench.actions.treeView.abapfs.objectList.collapseAll")
    }

    private setLoading(loading: boolean) {
        this.isLoading = loading
        if (this.treeView) {
            this.treeView.message = loading ? "Loading..." : undefined
        }
    }

    /** Force a full refresh, clearing all caches */
    public forceRefresh() {
        this.componentsCache.clear()
        this.uriCache.clear()
        this.fileToMainCache.clear()
        this.cachedMainProgramUri = undefined
        this.cachedMainProgramName = undefined
        this.refresh(this.currentUri, true)
    }

    getTreeItem(element: ObjectListItem): TreeItem {
        return element
    }

    async getChildren(element?: ObjectListItem): Promise<ObjectListItem[]> {
        if (element) {
            return element.children
        }
        return this.cachedItems
    }

    private async refresh(uri?: Uri, forceRefresh = false) {
        if (!uri || uri.scheme !== ADTSCHEME) {
            // Non-ABAP file or undefined - DON'T clear the list
            // Just ignore and keep showing old content
            // This happens briefly when switching between editors
            return
        }

        this.currentUri = uri
        this.connId = uri.authority
        const file = uriAbapFile(uri)

        if (!file) {
            this.currentObject = undefined
            return
        }

        this.currentObject = file.object

        // NEVER clear the list first - keep showing old content
        // Check if we can reuse existing cache (same main program)
        if (!forceRefresh && this.cachedItems.length > 0 && this.cachedMainProgramUri) {
            // First try synchronous lookup from fileToMainCache
            const cachedMainForThisFile = this.fileToMainCache.get(uri.path)
            
            if (cachedMainForThisFile && cachedMainForThisFile === this.cachedMainProgramUri) {
                // Same main program - no refresh needed
                return
            }
            
            // If not in cache yet, do async check WITHOUT clearing the list
            // This runs in background while old list stays visible
            const mainProgramKey = await this.getMainProgramKey()
            
            if (mainProgramKey && mainProgramKey === this.cachedMainProgramUri) {
                // Same main program - store in cache for next time and keep old list
                this.fileToMainCache.set(uri.path, mainProgramKey)
                return
            }
        }

        // Main program changed (or first load) - now rebuild
        this.setLoading(true)
        try {
            await this.currentObject.loadStructure()
            await this.buildObjectList()
        } catch (e) {
            // Ignore error
        } finally {
            this.setLoading(false)
        }

        this._onDidChangeTreeData.fire()
    }

    /** Get a key identifying the main program for caching purposes */
    private async getMainProgramKey(): Promise<string | undefined> {
        if (!this.connId || !this.currentObject || !this.currentUri) return undefined
        
        const includeService = IncludeService.get(this.connId)
        if (includeService?.needMain(this.currentObject)) {
            // It's an include - get main program
            const candidates = await includeService.candidates(this.currentUri.path)
            const currentMain = includeService.current(this.currentUri.path)
            const mainProgram = currentMain || candidates?.[0]
            return mainProgram?.["adtcore:uri"]
        } else {
            // It's a main object
            return this.currentObject.path
        }
    }

    /** Update highlight on cached items without refetching */
    private updateHighlight() {
        if (!this.currentObject) return
        const currentName = this.currentObject.name
        
        const updateItems = (items: ObjectListItem[]) => {
            for (const item of items) {
                if (item.objectType && item.label) {
                    const isCurrentObj = item.label === currentName
                    const desc = typeof item.description === "string" ? item.description : ""
                    if (isCurrentObj) {
                        item.description = `${item.objectType} ★`
                    } else if (desc.includes("★")) {
                        item.description = item.objectType
                    }
                }
                if (item.children.length > 0) {
                    updateItems(item.children)
                }
            }
        }
        updateItems(this.cachedItems)
    }

    private async buildObjectList() {
        if (!this.currentObject || !this.currentUri || !this.connId) return

        const items: ObjectListItem[] = []
        const root = uriRoot(this.currentUri)

        // Get the main program if current object is an include
        const includeService = IncludeService.get(this.connId)
        const needsMainProgram = includeService?.needMain(this.currentObject)

        if (needsMainProgram) {
            // Current object is an include, show main program(s) and sibling includes
            await this.buildIncludeView(items, includeService)
        } else {
            // Current object is expandable (like PROG/P, CLAS/OC, FUGR/F), show its includes/components
            await this.buildMainObjectView(items, root)
        }

        this.cachedItems = items
    }

    private async buildIncludeView(items: ObjectListItem[], includeService: IncludeService) {
        if (!this.currentUri || !this.currentObject) return

        // Get main program candidates
        const candidates = await includeService.candidates(this.currentUri.path)
        const currentMain = includeService.current(this.currentUri.path)

        if (candidates && candidates.length > 0) {
            // Show main program(s)
            const mainProgram = currentMain || candidates[0]
            if (!mainProgram) return

            const root = uriRoot(this.currentUri)
            const mainName = includeService.mainName(mainProgram)
            
            // Find the main program folder in the filesystem
            const mainAdtPath = mainProgram["adtcore:uri"]
            
            // Store for cache comparison
            this.cachedMainProgramUri = mainAdtPath
            this.cachedMainProgramName = mainName
            
            // Store mapping from current file to its main program (for instant lookup on next switch)
            if (this.currentUri) {
                this.fileToMainCache.set(this.currentUri.path, mainAdtPath)
            }
            
            const mainFolder = await this.findProgramFolder(root, mainAdtPath)
            
            // Get the URI for the main program (the main source file)
            let mainUri: Uri | undefined
            if (mainFolder) {
                const mainInclude = mainFolder.folder.mainInclude(mainFolder.path)
                if (mainInclude) {
                    mainUri = createUri(this.currentUri.authority, mainInclude.path)
                }
            }
            if (!mainUri) {
                mainUri = await this.findUriFromAdtPath(root, mainAdtPath)
            }

            // Create main program item with its includes as children
            const mainChildren: ObjectListItem[] = []

            // Includes are stored in separate folders (e.g., $TMP/Source Code Library/Includes/)
            // NOT inside the main program folder. Use cached nodeContents if available.
            try {
                // Check cache first
                let components = this.componentsCache.get(mainName)
                if (!components) {
                    // Call nodeContents directly on the service to get program includes
                    components = await root.service.nodeContents("PROG/P", mainName)
                    this.componentsCache.set(mainName, components)
                }
                
                // Add each component, finding its actual filesystem path
                await this.addComponentsToList(
                    mainChildren, 
                    components, 
                    this.currentUri.authority, 
                    root,
                    mainAdtPath,  // Pass main program URI for cache
                    this.currentObject.name  // Highlight current include
                )
            } catch (e) {
                // ignore error
            }

            const mainItem = new ObjectListItem(
                "mainProgram",
                mainName,
                mainUri,
                mainProgram["adtcore:uri"],
                mainProgram["adtcore:type"],
                mainChildren.length > 0 ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None,
                mainChildren
            )
            items.push(mainItem)

            // If there are multiple main program candidates, show them
            if (candidates.length > 1) {
                const otherMains: ObjectListItem[] = []
                for (const candidate of candidates) {
                    if (candidate["adtcore:uri"] !== mainProgram["adtcore:uri"]) {
                        const candidateName = includeService.mainName(candidate)
                        const candidateUri = await this.findUriFromAdtPath(root, candidate["adtcore:uri"])
                        otherMains.push(new ObjectListItem(
                            "mainProgram",
                            candidateName,
                            candidateUri,
                            candidate["adtcore:uri"],
                            candidate["adtcore:type"]
                        ))
                    }
                }
                if (otherMains.length > 0) {
                    items.push(new ObjectListItem(
                        "category",
                        "Other Main Programs",
                        undefined,
                        undefined,
                        undefined,
                        TreeItemCollapsibleState.Collapsed,
                        otherMains
                    ))
                }
            }
        }
    }

    private async buildMainObjectView(items: ObjectListItem[], root: Root) {
        if (!this.currentObject || !this.currentUri) return

        // Try to find the folder for this object in the filesystem
        const folderResult = await this.findProgramFolder(root, this.currentObject.path)
        
        // Current object is the main - show it and its components
        const currentItem = new ObjectListItem(
            "mainProgram",
            this.currentObject.name,
            this.currentUri,
            this.currentObject.path,
            this.currentObject.type,
            TreeItemCollapsibleState.None
        )
        items.push(currentItem)

        // Try to get children from folder first
        if (folderResult && folderResult.folder) {
            const includesCategory: ObjectListItem[] = []
            
            // Always refresh folder to load all includes from server
            try {
                await folderResult.folder.refresh()
            } catch (e) {
                // ignore refresh errors
            }
            
            // Iterate through folder children
            await this.addFolderChildrenToList(
                includesCategory,
                folderResult.folder,
                folderResult.path,
                this.currentUri.authority,
                root
            )
            
            if (includesCategory.length > 0) {
                items.push(new ObjectListItem(
                    "category",
                    "Includes / Components",
                    undefined,
                    undefined,
                    undefined,
                    TreeItemCollapsibleState.Collapsed,
                    includesCategory
                ))
            }
        } else if (this.currentObject.expandable) {
            // Fallback to childComponents if no folder found
            try {
                const components = await this.currentObject.childComponents()
                const includesCategory: ObjectListItem[] = []

                await this.addComponentsToList(includesCategory, components, this.currentUri.authority, root, this.currentObject.path)

                if (includesCategory.length > 0) {
                    items.push(new ObjectListItem(
                        "category",
                        "Includes / Components",
                        undefined,
                        undefined,
                        undefined,
                        TreeItemCollapsibleState.Collapsed,
                        includesCategory
                    ))
                }
            } catch (e) {
                // ignore error if can't get children
            }
        } else {
            // Not expandable - check if it has a parent that is expandable
            try {
                const parent = this.currentObject.parent
                if (parent && parent.expandable) {
                    const parentFolder = await this.findProgramFolder(root, parent.path)
                    
                    // Get URI for parent's main include
                    let parentUri: Uri | undefined
                    if (parentFolder?.folder) {
                        const mainInclude = parentFolder.folder.mainInclude(parentFolder.path)
                        if (mainInclude) {
                            parentUri = createUri(this.currentUri.authority, mainInclude.path)
                        }
                    }
                    if (!parentUri) {
                        parentUri = await this.findUriFromAdtPath(root, parent.path)
                    }
                    
                    const parentItem = new ObjectListItem(
                        "mainProgram",
                        parent.name,
                        parentUri,
                        parent.path,
                        parent.type,
                        TreeItemCollapsibleState.None
                    )
                    // Clear items and add parent first
                    items.length = 0
                    items.push(parentItem)

                    // Add sibling components from folder
                    const siblings: ObjectListItem[] = []
                    
                    if (parentFolder?.folder) {
                        try {
                            await parentFolder.folder.refresh()
                        } catch (e) {
                            // ignore refresh errors
                        }
                        await this.addFolderChildrenToList(
                            siblings,
                            parentFolder.folder,
                            parentFolder.path,
                            this.currentUri.authority,
                            root,
                            this.currentObject.name
                        )
                    } else {
                        // Fallback to childComponents
                        const components = await parent.childComponents()
                        await this.addComponentsToList(siblings, components, this.currentUri.authority, root, parent.path, this.currentObject.name)
                    }

                    if (siblings.length > 0) {
                        items.push(new ObjectListItem(
                            "category",
                            "Includes / Components",
                            undefined,
                            undefined,
                            undefined,
                            TreeItemCollapsibleState.Collapsed,
                            siblings
                        ))
                    }
                }
            } catch (e) {
                // ignore error
            }
        }
    }

    /** Find the AbapFolder for a program given its ADT path */
    private async findProgramFolder(root: Root, adtPath: string): Promise<{ folder: AbapFolder, path: string } | undefined> {
        try {
            const result = await root.findByAdtUri(adtPath, false)
            if (result?.file && isAbapFolder(result.file)) {
                return { folder: result.file, path: result.path }
            }
            // If result is a file not a folder, try to get parent path
            if (result?.path) {
                const parentPath = result.path.replace(/\/[^\/]+$/, "")
                const parentNode = root.getNode(parentPath)
                if (parentNode && isAbapFolder(parentNode)) {
                    return { folder: parentNode, path: parentPath }
                }
            }
        } catch (e) {
            // ignore error
        }
        return undefined
    }

    /** Add children from an AbapFolder to the list */
    private async addFolderChildrenToList(
        list: ObjectListItem[],
        folder: AbapFolder,
        basePath: string,
        authority: string,
        root: Root,
        highlightName?: string
    ) {
        // Iterate through all children in the folder
        for (const child of folder) {
            if (!child.name) continue  // Skip empty/unnamed children
            const childPath = `${basePath}/${child.name}`
            const childUri = createUri(authority, childPath)
            
            if (isAbapFile(child.file)) {
                const obj = child.file.object
                if (!obj.name) continue  // Skip objects without a name
                const isCurrentObj = highlightName && obj.name === highlightName
                const item = new ObjectListItem(
                    "include",
                    obj.name,
                    childUri,
                    obj.path,
                    obj.type
                )
                if (isCurrentObj) {
                    item.description = `${obj.type} ★ (current)`
                } else {
                    item.description = obj.type
                }
                list.push(item)
            } else if (isAbapFolder(child.file)) {
                // Recursively add folder contents
                const subChildren: ObjectListItem[] = []
                if (child.file.size === 0) {
                    await child.file.refresh()
                }
                await this.addFolderChildrenToList(subChildren, child.file, childPath, authority, root, highlightName)
                
                if (subChildren.length > 0) {
                    list.push(new ObjectListItem(
                        "category",
                        child.name,
                        undefined,
                        undefined,
                        undefined,
                        TreeItemCollapsibleState.Collapsed,
                        subChildren
                    ))
                }
            }
        }
    }

    private async addComponentsToList(
        list: ObjectListItem[],
        components: NodeStructure,
        authority: string,
        root: Root,
        mainAdtPath?: string,
        highlightName?: string
    ) {
        const nodes = components.nodes || []
        const typeMap = new Map<string, Node[]>()

        // Group by object type - skip nodes without a name
        for (const node of nodes) {
            if (!node.OBJECT_NAME) continue  // Skip empty/unnamed nodes
            const type = node.OBJECT_TYPE || "Other"
            if (!typeMap.has(type)) {
                typeMap.set(type, [])
            }
            typeMap.get(type)!.push(node)
        }

        // Pre-fetch all URIs in parallel for speed
        const allNodes = nodes.filter(n => n.OBJECT_URI && n.OBJECT_NAME)
        const uriPromises = allNodes.map(n => this.findUriFromAdtPath(root, n.OBJECT_URI, authority))
        const uris = await Promise.all(uriPromises)
        const uriMap = new Map<string, Uri | undefined>()
        allNodes.forEach((n, i) => {
            const uri = uris[i]
            uriMap.set(n.OBJECT_URI, uri)
            // Populate fileToMainCache for instant lookup on next editor switch
            if (mainAdtPath && uri) {
                this.fileToMainCache.set(uri.path, mainAdtPath)
            }
        })

        // Add grouped items
        for (const [type, typeNodes] of typeMap) {
            const typeLabel = components.objectTypes.find(t => t.OBJECT_TYPE === type)?.OBJECT_TYPE_LABEL || type
            const isIncludeType = type.toUpperCase().includes("PROG/I") || type.toUpperCase().includes("INCL")

            if (typeNodes.length === 1) {
                // Single item - add directly
                const node = typeNodes[0]
                if (!node) continue
                const nodeUri = uriMap.get(node.OBJECT_URI)
                const isCurrentObj = highlightName && node.OBJECT_NAME === highlightName
                
                // Get symbols for include files
                let symbolChildren: ObjectListItem[] = []
                if (isIncludeType && nodeUri) {
                    symbolChildren = await this.getSymbolsForUri(nodeUri)
                }
                
                const item = new ObjectListItem(
                    "component",
                    node.OBJECT_NAME,
                    nodeUri,
                    node.OBJECT_URI,
                    typeLabel,
                    symbolChildren.length > 0 ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None,
                    symbolChildren
                )
                if (isCurrentObj) {
                    item.description = `${typeLabel} ★`
                }
                list.push(item)
            } else {
                // Multiple items of same type - group them
                const children: ObjectListItem[] = []
                for (const node of typeNodes) {
                    const nodeUri = uriMap.get(node.OBJECT_URI)
                    const isCurrentObj = highlightName && node.OBJECT_NAME === highlightName
                    
                    // Get symbols for include files
                    let symbolChildren: ObjectListItem[] = []
                    if (isIncludeType && nodeUri) {
                        symbolChildren = await this.getSymbolsForUri(nodeUri)
                    }
                    
                    const item = new ObjectListItem(
                        "component",
                        node.OBJECT_NAME,
                        nodeUri,
                        node.OBJECT_URI,
                        type,
                        symbolChildren.length > 0 ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None,
                        symbolChildren
                    )
                    if (isCurrentObj) {
                        item.description = "★ (current)"
                    }
                    children.push(item)
                }
                list.push(new ObjectListItem(
                    "category",
                    `${typeLabel} (${typeNodes.length})`,
                    undefined,
                    undefined,
                    type,
                    TreeItemCollapsibleState.Collapsed,
                    children
                ))
            }
        }
    }

    private async findUriFromAdtPath(root: Root, adtPath?: string, authority?: string): Promise<Uri | undefined> {
        if (!adtPath) return undefined
        const auth = authority || this.currentUri?.authority
        if (!auth) return undefined

        // Check cache first
        const cached = this.uriCache.get(adtPath)
        if (cached !== undefined) {
            return cached ? createUri(auth, cached) : undefined
        }

        try {
            // Use findByAdtUri to get the actual filesystem path
            const result = await root.findByAdtUri(adtPath, true)
            if (result?.path) {
                this.uriCache.set(adtPath, result.path)
                return createUri(auth, result.path)
            }
        } catch (e) {
            // If lookup fails, cache the failure
        }
        this.uriCache.set(adtPath, null)
        return undefined
    }

    private async findObjectByAdtPath(root: Root, adtPath: string): Promise<{ object: AbapObject, path?: string } | undefined> {
        try {
            // Use findByAdtUri with main=false to get the folder/container object (expandable)
            // not the source file
            const result = await root.findByAdtUri(adtPath, false)
            if (result?.file && isAbapStat(result.file)) {
                // If the object is expandable, return it
                if (result.file.object.expandable) {
                    return { object: result.file.object, path: result.path }
                }
                // If not expandable, try to get parent which might be expandable
                const parent = result.file.object.parent
                if (parent && parent.expandable) {
                    return { object: parent, path: result.path }
                }
                return { object: result.file.object, path: result.path }
            }
        } catch (e) {
            // ignore
        }
        return undefined
    }

    dispose() {
        this.disposables.forEach(d => d.dispose())
    }

    // Command to refresh the view manually (clears cache)
    public refreshView() {
        this.forceRefresh()
    }

    /** Parse ABAP source to find FORMs, MODULEs, and METHODs */
    private parseSymbols(source: string): SymbolInfo[] {
        const symbols: SymbolInfo[] = []
        const lines = source.split(/\r?\n/)
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (!line || line.trim().startsWith('*')) continue  // Skip empty lines and comments
            const code = line.split('"')[0]  // Ignore inline comments
            if (!code) continue
            
            let match: RegExpMatchArray | null
            // FORM
            if ((match = code.match(/^\s*FORM\s+(\S+)/i)) && match[1]) {
                symbols.push({ name: match[1], type: "FORM", line: i })
            }
            // MODULE
            else if ((match = code.match(/^\s*MODULE\s+(\S+)/i)) && match[1]) {
                symbols.push({ name: match[1], type: "MODULE", line: i })
            }
            // METHOD
            else if ((match = code.match(/^\s*METHOD\s+(\S+)/i)) && match[1]) {
                symbols.push({ name: match[1], type: "METHOD", line: i })
            }
        }
        return symbols
    }

    /** Get symbols for an include file */
    private async getSymbolsForUri(uri: Uri): Promise<ObjectListItem[]> {
        const children: ObjectListItem[] = []
        try {
            const doc = await workspace.openTextDocument(uri)
            const source = doc.getText()
            const symbols = this.parseSymbols(source)
            
            for (const sym of symbols) {
                children.push(new ObjectListItem(
                    "symbol",
                    sym.name,
                    uri,
                    undefined,
                    sym.type,
                    TreeItemCollapsibleState.None,
                    [],
                    sym.line
                ))
            }
        } catch (e) {
            // Ignore errors - file might not be readable
        }
        return children
    }
}

export const objectListProvider = new ObjectListProvider()
