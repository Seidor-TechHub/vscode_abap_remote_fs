import {
    CancellationToken,
    LanguageModelTextPart,
    LanguageModelTool,
    LanguageModelToolInvocationOptions,
    LanguageModelToolInvocationPrepareOptions,
    LanguageModelToolResult,
    PreparedToolInvocation,
    ProviderResult,
    Uri,
    window,
    workspace
} from "vscode"
import { getClient, uriRoot } from "../conections"
import { createUri, AdtObjectFinder } from "../operations/AdtObjectFinder"
import { isAbapStat, isAbapFile, isAbapFolder } from "abapfs"
import { getRoot } from "../conections"
import { PACKAGE } from "abapobject"

// ==================== Read ABAP Source Code ====================

interface ReadSourceInput {
    url: string  // ADT URL of the object to read
}

export class ReadSourceTool implements LanguageModelTool<ReadSourceInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<ReadSourceInput>,
        token: CancellationToken
    ): Promise<LanguageModelToolResult> {
        const { url } = options.input
        const uri = Uri.parse(url)
        const client = getClient(uri.authority)

        try {
            const source = await client.getObjectSource(uri.path)

            // Truncate if too long (to avoid context overflow)
            const maxLength = 50000
            const truncated = source.length > maxLength
            const displaySource = truncated ? source.substring(0, maxLength) + "\n... [truncated]" : source

            const contentText = [
                `\`\`\`abap\n${displaySource}\n\`\`\``,
                truncated ? `**Note**: Source truncated from ${source.length} to ${maxLength} characters.` : "",
                `File: ${uri.path}`
            ].filter(Boolean)

            const content = contentText.map(t => new LanguageModelTextPart(t))
            return new LanguageModelToolResult(content)
        } catch (e) {
            return new LanguageModelToolResult([
                new LanguageModelTextPart(`Error reading source: ${String(e)}`)
            ])
        }
    }

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<ReadSourceInput>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation> {
        const uri = Uri.parse(options.input.url)
        const client = getClient(uri.authority)
        if (client)
            return {
                invocationMessage: `Reading source code from ${uri.path.replace(/.*\//, "")}`
            }
        throw new Error(`No ABAP filesystem registered for ${uri.authority}`)
    }
}

// ==================== Get Object Structure ====================

interface GetObjectStructureInput {
    url: string
}

export class GetObjectStructureTool implements LanguageModelTool<GetObjectStructureInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<GetObjectStructureInput>,
        token: CancellationToken
    ): Promise<LanguageModelToolResult> {
        const { url } = options.input
        const uri = Uri.parse(url)
        const client = getClient(uri.authority)

        try {
            const structure = await client.objectStructure(uri.path)

            const result = {
                name: structure.metaData["adtcore:name"],
                type: structure.metaData["adtcore:type"],
                path: uri.path,
                structure: {
                    objectUrl: structure.objectUrl,
                    metaData: structure.metaData,
                    links: structure.links?.map(l => ({
                        href: l.href,
                        rel: l.rel,
                        type: l.type
                    }))
                }
            }

            const contentText = [
                JSON.stringify(result, null, 2),
                `**Object**: ${result.name} (${result.type})`
            ]
            const content = contentText.map(t => new LanguageModelTextPart(t))
            return new LanguageModelToolResult(content)
        } catch (e) {
            return new LanguageModelToolResult([
                new LanguageModelTextPart(`Error getting object structure: ${String(e)}`)
            ])
        }
    }

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<GetObjectStructureInput>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation> {
        const uri = Uri.parse(options.input.url)
        const client = getClient(uri.authority)
        if (client)
            return {
                invocationMessage: `Getting structure for ${uri.path.replace(/.*\//, "")}`
            }
        throw new Error(`No ABAP filesystem registered for ${uri.authority}`)
    }
}

// ==================== Get Object Includes/Components ====================

interface GetObjectComponentsInput {
    url: string
}

interface ComponentInfo {
    name: string
    type: string
    uri: string
    description: string
}

export class GetObjectComponentsTool implements LanguageModelTool<GetObjectComponentsInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<GetObjectComponentsInput>,
        token: CancellationToken
    ): Promise<LanguageModelToolResult> {
        const { url } = options.input
        const uri = Uri.parse(url)
        const root = uriRoot(uri)

        try {
            const [nodePath] = await root.getNodePathAsync(uri.path)
            if (!nodePath || !isAbapStat(nodePath.file)) {
                return new LanguageModelToolResult([
                    new LanguageModelTextPart(`Object not found at ${uri.path}`)
                ])
            }

            const obj = nodePath.file.object
            const children = await obj.childComponents()

            // childComponents returns NodeStructure which has nodes array
            const nodes = children.nodes || []
            const components: ComponentInfo[] = nodes.map((c: any) => ({
                name: c.OBJECT_NAME || c["adtcore:name"] || "",
                type: c.OBJECT_TYPE || c["adtcore:type"] || "",
                uri: c.OBJECT_URI || c["adtcore:uri"] || "",
                description: c.OBJECT_VIT_URI || c["adtcore:description"] || ""
            }))

            // Create clickable URIs for each component
            const componentsWithLinks = components.map((c: ComponentInfo) => ({
                ...c,
                vscodeUri: c.uri ? createUri(uri.authority, `/${obj.type.toLowerCase()}/${obj.name}/${c.name}`).toString() : undefined
            }))

            const contentText = [
                JSON.stringify({ object: obj.name, type: obj.type, components: componentsWithLinks }, null, 2),
                `**Object ${obj.name}** has ${components.length} component(s).`,
                `**IMPORTANT**: Include clickable adt:// links for each component so the user can open them.`
            ]
            const content = contentText.map(t => new LanguageModelTextPart(t))
            return new LanguageModelToolResult(content)
        } catch (e) {
            return new LanguageModelToolResult([
                new LanguageModelTextPart(`Error getting components: ${String(e)}`)
            ])
        }
    }

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<GetObjectComponentsInput>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation> {
        const uri = Uri.parse(options.input.url)
        const client = getClient(uri.authority)
        if (client)
            return {
                invocationMessage: `Getting components for ${uri.path.replace(/.*\//, "")}`
            }
        throw new Error(`No ABAP filesystem registered for ${uri.authority}`)
    }
}

// ==================== Open Object in Editor ====================

interface OpenObjectInput {
    url: string          // ADT URL (adt://connection/path) of the object to open
    objectName?: string  // Optional: object name to search for if URL not known
}

export class OpenObjectTool implements LanguageModelTool<OpenObjectInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<OpenObjectInput>,
        token: CancellationToken
    ): Promise<LanguageModelToolResult> {
        const { url, objectName } = options.input

        try {
            let connId: string
            let adtUri: string

            if (url) {
                // URL provided directly
                const targetUri = Uri.parse(url)
                connId = targetUri.authority
                adtUri = targetUri.path
            } else if (objectName) {
                // Search for object by name - need to find connection first
                // Get connections from workspace folders
                const folders = workspace.workspaceFolders?.filter(f => f.uri.scheme === "adt") || []
                const firstFolder = folders[0]
                if (!firstFolder) {
                    return new LanguageModelToolResult([
                        new LanguageModelTextPart("No ABAP connections available. Please connect to a system first.")
                    ])
                }

                // Use first ADT connection
                connId = firstFolder.uri.authority
                const finder = new AdtObjectFinder(connId)
                const object = await finder.findObjectByName(objectName)

                if (!object) {
                    return new LanguageModelToolResult([
                        new LanguageModelTextPart(`Object "${objectName}" not found in the system.`)
                    ])
                }
                adtUri = object.uri
            } else {
                return new LanguageModelToolResult([
                    new LanguageModelTextPart("Either 'url' or 'objectName' must be provided.")
                ])
            }

            // Open the object in editor
            const root = getRoot(connId)
            const result = await root.findByAdtUri(adtUri, true)

            if (!result || !result.file || !result.path) {
                return new LanguageModelToolResult([
                    new LanguageModelTextPart(`Object not found in workspace: ${adtUri}`)
                ])
            }

            const { file, path } = result
            const fileUri = createUri(connId, path)

            if (isAbapFolder(file) && file.object.type === PACKAGE) {
                // It's a package - can't open in editor, but reveal in explorer
                return new LanguageModelToolResult([
                    new LanguageModelTextPart(`"${file.object.name}" is a package and cannot be opened in editor. Use the file explorer to browse its contents.`)
                ])
            }

            if (isAbapFile(file)) {
                // Open the file in editor
                const doc = await workspace.openTextDocument(fileUri)
                await window.showTextDocument(doc)

                return new LanguageModelToolResult([
                    new LanguageModelTextPart(`Successfully opened "${file.object.name}" in the editor.`),
                    new LanguageModelTextPart(`File URI: ${fileUri.toString()}`),
                    new LanguageModelTextPart(`You can now edit this file directly. After making changes, use the abap_activate tool to activate the object.`)
                ])
            }

            return new LanguageModelToolResult([
                new LanguageModelTextPart(`Object found but could not be opened: ${adtUri}`)
            ])

        } catch (e) {
            return new LanguageModelToolResult([
                new LanguageModelTextPart(`Error opening object: ${String(e)}`)
            ])
        }
    }

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<OpenObjectInput>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation> {
        const { url, objectName } = options.input
        const displayName = objectName || (url ? Uri.parse(url).path.replace(/.*\//, "") : "object")
        return {
            invocationMessage: `Opening ${displayName} in editor...`
        }
    }
}
