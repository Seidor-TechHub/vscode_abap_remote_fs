import {
    CancellationToken,
    LanguageModelTextPart,
    LanguageModelTool,
    LanguageModelToolInvocationOptions,
    LanguageModelToolInvocationPrepareOptions,
    LanguageModelToolResult,
    PreparedToolInvocation,
    ProviderResult,
    Uri
} from "vscode"
import { getClient } from "../conections"
import { TransportTarget, TransportRequest, TransportTask, TransportsOfUser, TransportConfiguration } from "abap-adt-api"

// ==================== Get User Transports ====================

interface GetTransportsInput {
    url: string
    user?: string
}

interface TransportSummary {
    number: string
    owner: string
    description: string
    status: string
    type: string
    target?: string
    objects: Array<{
        pgmid: string
        type: string
        name: string
    }>
    tasks?: TransportSummary[]
}

function summarizeTask(task: TransportTask): TransportSummary {
    const isRequest = "tasks" in task
    return {
        number: task["tm:number"],
        owner: task["tm:owner"],
        description: task["tm:desc"],
        status: task["tm:status"],
        type: isRequest ? "request" : "task",
        objects: task.objects.map(o => ({
            pgmid: o["tm:pgmid"],
            type: o["tm:type"],
            name: o["tm:name"]
        })),
        tasks: isRequest ? (task as TransportRequest).tasks.map(summarizeTask) : undefined
    }
}

function summarizeTransports(targets: TransportTarget[], category: string): TransportSummary[] {
    const result: TransportSummary[] = []
    for (const target of targets) {
        const targetName = `${target["tm:name"]} ${target["tm:desc"]}`
        for (const transport of [...target.modifiable, ...target.released]) {
            const summary = summarizeTask(transport)
            summary.target = targetName
            summary.type = category
            result.push(summary)
        }
    }
    return result
}

export class GetTransportsTool implements LanguageModelTool<GetTransportsInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<GetTransportsInput>,
        token: CancellationToken
    ): Promise<LanguageModelToolResult> {
        const { url, user } = options.input
        const uri = Uri.parse(url)
        const client = getClient(uri.authority)
        const effectiveUser = user?.toUpperCase() || client.username.toUpperCase()

        try {
            let transports: TransportsOfUser
            let methodUsed = "userTransports"

            // Check if the system uses transport configurations (newer systems)
            const hasConfig = await client.hasTransportConfig()

            if (hasConfig) {
                methodUsed = "transportsByConfig"
                // Get transport configurations
                const configs = await client.transportConfigurations()
                const config = configs[0]
                if (config) {
                    // Get current config
                    const currentConfig = await client.getTransportConfiguration(config.link)

                    // Create a config request for all transport types
                    const searchConfig: TransportConfiguration = {
                        ...currentConfig,
                        User: effectiveUser,
                        WorkbenchRequests: true,
                        CustomizingRequests: true,
                        Modifiable: true,
                        Released: true  // Include released transports too
                    }

                    // Update config temporarily
                    await client.setTransportsConfig(config.link, config.etag, searchConfig)

                    // Get fresh config with new etag
                    const updatedConfigs = await client.transportConfigurations()
                    const updatedConfig = updatedConfigs[0]
                    if (updatedConfig) {
                        // Get transports using config
                        transports = await client.transportsByConfig(updatedConfig.link)
                    } else {
                        // No updated config, try old method
                        transports = await client.userTransports(effectiveUser)
                    }
                } else {
                    // No configs, try old method
                    transports = await client.userTransports(effectiveUser)
                }
            } else {
                // Older system - use direct user transports
                transports = await client.userTransports(effectiveUser)
            }

            const allTransports: TransportSummary[] = []

            if (transports.workbench?.length) {
                allTransports.push(...summarizeTransports(transports.workbench, "workbench"))
            }
            if (transports.customizing?.length) {
                allTransports.push(...summarizeTransports(transports.customizing, "customizing"))
            }
            // Note: transportofcopies may be available in some systems via extended API
            const extTransports = transports as any
            if (extTransports.transportofcopies?.length) {
                allTransports.push(...summarizeTransports(extTransports.transportofcopies, "transportofcopies"))
            }

            const contentText = [
                JSON.stringify({
                    user: effectiveUser,
                    method: methodUsed,
                    transportCount: allTransports.length,
                    transports: allTransports.slice(0, 50)
                }, null, 2),
                `Found ${allTransports.length} transport request(s) for user ${effectiveUser}${allTransports.length > 50 ? " (showing first 50)" : ""}.`,
                allTransports.length === 0 ? `**Note**: No transports found. This might be because the user has no modifiable/released transports, or the ADT API requires different permissions.` : "",
                `**TIP**: Use abap_get_transport_details to get more details about a specific transport.`
            ].filter(Boolean)
            const content = contentText.map(t => new LanguageModelTextPart(t))
            return new LanguageModelToolResult(content)
        } catch (e) {
            return new LanguageModelToolResult([
                new LanguageModelTextPart(`Error getting transports: ${String(e)}`)
            ])
        }
    }

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<GetTransportsInput>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation> {
        const uri = Uri.parse(options.input.url)
        const client = getClient(uri.authority)
        if (client)
            return {
                invocationMessage: `Fetching transports for ${options.input.user || client.username} on ${uri.authority}`
            }
        throw new Error(`No ABAP filesystem registered for ${uri.authority}`)
    }
}

// ==================== Get Transport Details ====================

interface GetTransportDetailsInput {
    url: string
    transportNumber: string
}

export class GetTransportDetailsTool implements LanguageModelTool<GetTransportDetailsInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<GetTransportDetailsInput>,
        token: CancellationToken
    ): Promise<LanguageModelToolResult> {
        const { url, transportNumber } = options.input
        const uri = Uri.parse(url)
        const client = getClient(uri.authority)
        const transportNum = transportNumber.toUpperCase()

        try {
            // Try to get transports using the config method with wildcard user "*"
            let transports: TransportsOfUser | undefined
            const hasConfig = await client.hasTransportConfig()

            const searchInTargets = (targets: TransportTarget[]): TransportRequest | undefined => {
                for (const target of targets) {
                    for (const transport of [...target.modifiable, ...target.released]) {
                        if (transport["tm:number"] === transportNum) {
                            return transport
                        }
                        // Also check subtasks
                        for (const task of transport.tasks) {
                            if (task["tm:number"] === transportNum) {
                                return transport // Return parent transport
                            }
                        }
                    }
                }
                return undefined
            }

            let foundTransport: TransportRequest | undefined

            if (hasConfig) {
                // Use config method with wildcard to search all users
                const configs = await client.transportConfigurations()
                const config = configs[0]
                if (config) {
                    const currentConfig = await client.getTransportConfiguration(config.link)

                    // Search with wildcard user "*" to find all transports
                    const searchConfig: TransportConfiguration = {
                        ...currentConfig,
                        User: "*",  // Wildcard to search all users
                        WorkbenchRequests: true,
                        CustomizingRequests: true,
                        Modifiable: true,
                        Released: true
                    }

                    await client.setTransportsConfig(config.link, config.etag, searchConfig)
                    const updatedConfigs = await client.transportConfigurations()
                    const updatedConfig = updatedConfigs[0]
                    if (updatedConfig) {
                        transports = await client.transportsByConfig(updatedConfig.link)
                    }
                }
            }

            if (!transports) {
                // Fallback to user transports
                transports = await client.userTransports(client.username.toUpperCase())
            }

            foundTransport = searchInTargets(transports.workbench || [])
                || searchInTargets(transports.customizing || [])
                || searchInTargets((transports as any).transportofcopies || [])

            if (!foundTransport) {
                return new LanguageModelToolResult([
                    new LanguageModelTextPart(`Transport ${transportNum} not found. The transport might be:\n- Already released and archived\n- Owned by a user without access\n- In a different client or system\n\n**TIP**: Try searching in SAP GUI using SE09/SE10.`)
                ])
            }

            const details = {
                number: foundTransport["tm:number"],
                owner: foundTransport["tm:owner"],
                description: foundTransport["tm:desc"],
                status: foundTransport["tm:status"],
                uri: foundTransport["tm:uri"],
                objects: foundTransport.objects.map(o => ({
                    pgmid: o["tm:pgmid"],
                    type: o["tm:type"],
                    name: o["tm:name"]
                })),
                tasks: foundTransport.tasks.map(t => ({
                    number: t["tm:number"],
                    owner: t["tm:owner"],
                    description: t["tm:desc"],
                    status: t["tm:status"],
                    objects: t.objects.map(o => ({
                        pgmid: o["tm:pgmid"],
                        type: o["tm:type"],
                        name: o["tm:name"]
                    }))
                }))
            }

            const totalObjects = details.objects.length + details.tasks.reduce((sum, t) => sum + t.objects.length, 0)
            const statusText = details.status === "D" ? "Modifiable (not released)" :
                details.status === "R" ? "Released" :
                    details.status === "O" ? "Released (exported)" : details.status

            const contentText = [
                JSON.stringify(details, null, 2),
                `Transport ${transportNum} has ${details.tasks.length} task(s) and ${totalObjects} total object(s).`,
                `Status: ${statusText}`,
                `Owner: ${details.owner}`
            ]
            const content = contentText.map(t => new LanguageModelTextPart(t))
            return new LanguageModelToolResult(content)
        } catch (e) {
            return new LanguageModelToolResult([
                new LanguageModelTextPart(`Error getting transport details: ${String(e)}`)
            ])
        }
    }

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<GetTransportDetailsInput>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation> {
        const uri = Uri.parse(options.input.url)
        const client = getClient(uri.authority)
        if (client)
            return {
                invocationMessage: `Fetching details for transport ${options.input.transportNumber}`
            }
        throw new Error(`No ABAP filesystem registered for ${uri.authority}`)
    }
}

// ==================== Search Transports ====================

interface SearchTransportsInput {
    url: string
    query: string  // Can be transport number pattern, description, or owner
}

export class SearchTransportsTool implements LanguageModelTool<SearchTransportsInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<SearchTransportsInput>,
        token: CancellationToken
    ): Promise<LanguageModelToolResult> {
        const { url, query } = options.input
        const uri = Uri.parse(url)
        const client = getClient(uri.authority)
        const queryUpper = query.toUpperCase()

        try {
            let transports: TransportsOfUser | undefined
            const hasConfig = await client.hasTransportConfig()

            if (hasConfig) {
                // Use config method with wildcard to search all users
                const configs = await client.transportConfigurations()
                const config = configs[0]
                if (config) {
                    const currentConfig = await client.getTransportConfiguration(config.link)

                    // Search with wildcard user "*" to find all transports
                    const searchConfig: TransportConfiguration = {
                        ...currentConfig,
                        User: "*",  // Wildcard to search all users
                        WorkbenchRequests: true,
                        CustomizingRequests: true,
                        Modifiable: true,
                        Released: true
                    }

                    await client.setTransportsConfig(config.link, config.etag, searchConfig)
                    const updatedConfigs = await client.transportConfigurations()
                    const updatedConfig = updatedConfigs[0]
                    if (updatedConfig) {
                        transports = await client.transportsByConfig(updatedConfig.link)
                    }
                }
            }

            if (!transports) {
                transports = await client.userTransports(client.username.toUpperCase())
            }

            const matches: TransportSummary[] = []

            const searchInTargets = (targets: TransportTarget[], category: string) => {
                for (const target of targets) {
                    for (const transport of [...target.modifiable, ...target.released]) {
                        const matchesQuery =
                            transport["tm:number"].includes(queryUpper) ||
                            transport["tm:desc"].toUpperCase().includes(queryUpper) ||
                            transport["tm:owner"].includes(queryUpper) ||
                            transport.objects.some(o => o["tm:name"].includes(queryUpper))

                        if (matchesQuery) {
                            const summary = summarizeTask(transport)
                            summary.target = `${target["tm:name"]} ${target["tm:desc"]}`
                            summary.type = category
                            matches.push(summary)
                        }
                    }
                }
            }

            searchInTargets(transports.workbench || [], "workbench")
            searchInTargets(transports.customizing || [], "customizing")
            searchInTargets((transports as any).transportofcopies || [], "transportofcopies")

            const contentText = [
                JSON.stringify({ query, matchCount: matches.length, matches: matches.slice(0, 30) }, null, 2),
                `Found ${matches.length} transport(s) matching "${query}"${matches.length > 30 ? " (showing first 30)" : ""}.`,
                matches.length === 0 ? `**Note**: No matches found. Try a different search term or check SAP GUI SE09/SE10.` : ""
            ].filter(Boolean)
            const content = contentText.map(t => new LanguageModelTextPart(t))
            return new LanguageModelToolResult(content)
        } catch (e) {
            return new LanguageModelToolResult([
                new LanguageModelTextPart(`Error searching transports: ${String(e)}`)
            ])
        }
    }

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<SearchTransportsInput>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation> {
        const uri = Uri.parse(options.input.url)
        const client = getClient(uri.authority)
        if (client)
            return {
                invocationMessage: `Searching transports for "${options.input.query}"`
            }
        throw new Error(`No ABAP filesystem registered for ${uri.authority}`)
    }
}
