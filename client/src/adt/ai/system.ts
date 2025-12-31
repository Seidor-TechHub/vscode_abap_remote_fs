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
    workspace
} from "vscode"
import { getClient, ADTSCHEME } from "../conections"

// ==================== Get System Info ====================

interface GetSystemInfoInput {
    url: string
}

export class GetSystemInfoTool implements LanguageModelTool<GetSystemInfoInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<GetSystemInfoInput>,
        token: CancellationToken
    ): Promise<LanguageModelToolResult> {
        const { url } = options.input
        const uri = Uri.parse(url)
        const client = getClient(uri.authority)

        try {
            const discovery = await client.adtDiscovery()
            const coreServices = await client.adtCoreDiscovery()

            const systemInfo = {
                connection: uri.authority,
                username: client.username,
                baseUrl: client.baseUrl,
                discoverySchemas: discovery.slice(0, 3).map((d: any) => ({
                    title: d.title,
                    scheme: d.scheme
                })),
                coreServicesCount: coreServices.length,
                hasAbapGit: false, // Will check below
                hasAtc: coreServices.some((s: any) => {
                    if (Array.isArray(s.collection)) {
                        return s.collection.some((c: any) => c.href?.includes("atc"))
                    }
                    return s.collection?.href?.includes("atc")
                })
            }

            // Try to check for abapGit support
            try {
                const repos = await client.gitRepos()
                systemInfo.hasAbapGit = Array.isArray(repos)
            } catch {
                // abapGit not available
            }

            const contentText = [
                JSON.stringify(systemInfo, null, 2),
                `Connected to ${uri.authority} as ${client.username}`,
                `**TIP**: Use abap_search to find objects, abap_get_transports to view transports.`
            ]
            const content = contentText.map(t => new LanguageModelTextPart(t))
            return new LanguageModelToolResult(content)
        } catch (e) {
            return new LanguageModelToolResult([
                new LanguageModelTextPart(`Error getting system info: ${String(e)}`)
            ])
        }
    }

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<GetSystemInfoInput>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation> {
        const uri = Uri.parse(options.input.url)
        const client = getClient(uri.authority)
        if (client)
            return {
                invocationMessage: `Getting system information for ${uri.authority}`
            }
        throw new Error(`No ABAP filesystem registered for ${uri.authority}`)
    }
}

// ==================== List Packages ====================

interface ListPackagesInput {
    url: string
    query?: string  // Optional filter pattern
}

export class ListPackagesTool implements LanguageModelTool<ListPackagesInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<ListPackagesInput>,
        token: CancellationToken
    ): Promise<LanguageModelToolResult> {
        const { url, query } = options.input
        const uri = Uri.parse(url)
        const client = getClient(uri.authority)

        try {
            const searchQuery = query ? `${query.toUpperCase()}*` : "Z*"
            const packages = await client.searchObject(searchQuery, "DEVC/K")

            const packageList = packages.slice(0, 50).map(p => ({
                name: p["adtcore:name"],
                description: p["adtcore:description"],
                uri: p["adtcore:uri"]
            }))

            const contentText = [
                JSON.stringify({ query: searchQuery, packages: packageList }, null, 2),
                `Found ${packages.length} package(s) matching "${searchQuery}" (showing first 50).`,
                `**TIP**: Use abap_search with type "DEVC/K" to search for more packages.`
            ]
            const content = contentText.map(t => new LanguageModelTextPart(t))
            return new LanguageModelToolResult(content)
        } catch (e) {
            return new LanguageModelToolResult([
                new LanguageModelTextPart(`Error listing packages: ${String(e)}`)
            ])
        }
    }

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<ListPackagesInput>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation> {
        const uri = Uri.parse(options.input.url)
        const client = getClient(uri.authority)
        if (client)
            return {
                invocationMessage: `Listing packages${options.input.query ? ` matching "${options.input.query}"` : ""}`
            }
        throw new Error(`No ABAP filesystem registered for ${uri.authority}`)
    }
}

// ==================== List Connections ====================

interface ListConnectionsInput { }

export class ListConnectionsTool implements LanguageModelTool<ListConnectionsInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<ListConnectionsInput>,
        token: CancellationToken
    ): Promise<LanguageModelToolResult> {
        const folders = workspace.workspaceFolders?.filter(f => f.uri.scheme === ADTSCHEME) || []

        if (folders.length === 0) {
            return new LanguageModelToolResult([
                new LanguageModelTextPart("No ABAP connections found. Please add an ABAP connection to the workspace first."),
                new LanguageModelTextPart("**TIP**: Use the command 'ABAPfs: Connect to an ABAP system' to add a connection.")
            ])
        }

        const connections = folders.map(f => ({
            name: f.name,
            authority: f.uri.authority,
            url: f.uri.toString()
        }))

        const contentText = [
            JSON.stringify({ connections }, null, 2),
            `Found ${connections.length} ABAP connection(s).`,
            `**IMPORTANT**: Use the "url" field from a connection as the "url" parameter for other ABAP tools.`
        ]
        const content = contentText.map(t => new LanguageModelTextPart(t))
        return new LanguageModelToolResult(content)
    }

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<ListConnectionsInput>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation> {
        return {
            invocationMessage: "Listing ABAP connections"
        }
    }
}

// ==================== Get Package Contents ====================

interface GetPackageContentsInput {
    url: string
    packageName: string
}

export class GetPackageContentsTool implements LanguageModelTool<GetPackageContentsInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<GetPackageContentsInput>,
        token: CancellationToken
    ): Promise<LanguageModelToolResult> {
        const { url, packageName } = options.input
        const uri = Uri.parse(url)
        const client = getClient(uri.authority)

        try {
            const contents = await client.nodeContents("DEVC/K", packageName.toUpperCase())

            const objects = contents.nodes.map(n => ({
                name: n.OBJECT_NAME,
                type: n.OBJECT_TYPE,
                description: n.OBJECT_VIT_URI,
                uri: n.OBJECT_URI
            }))

            const contentText = [
                JSON.stringify({
                    package: packageName.toUpperCase(),
                    objectCount: objects.length,
                    objects: objects.slice(0, 100)
                }, null, 2),
                `Package ${packageName.toUpperCase()} contains ${objects.length} object(s) (showing first 100).`,
                `**TIP**: Use abap_search to find specific objects within this package.`
            ]
            const content = contentText.map(t => new LanguageModelTextPart(t))
            return new LanguageModelToolResult(content)
        } catch (e) {
            return new LanguageModelToolResult([
                new LanguageModelTextPart(`Error getting package contents: ${String(e)}`)
            ])
        }
    }

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<GetPackageContentsInput>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation> {
        const uri = Uri.parse(options.input.url)
        const client = getClient(uri.authority)
        if (client)
            return {
                invocationMessage: `Getting contents of package ${options.input.packageName}`
            }
        throw new Error(`No ABAP filesystem registered for ${uri.authority}`)
    }
}
