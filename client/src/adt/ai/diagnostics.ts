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
import { getClient, uriRoot } from "../conections"
import { isAbapStat } from "abapfs"
import { AtcWorkList } from "abap-adt-api"

// ==================== Run ATC Check ====================

interface RunAtcCheckInput {
    url: string  // URL of the object to check
}

export class RunAtcCheckTool implements LanguageModelTool<RunAtcCheckInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<RunAtcCheckInput>,
        token: CancellationToken
    ): Promise<LanguageModelToolResult> {
        const { url } = options.input
        const uri = Uri.parse(url)
        const client = getClient(uri.authority)

        try {
            const structure = await client.objectStructure(uri.path)
            const objectUri = structure.objectUrl

            // Run ATC - use default variant
            const runResult = await client.createAtcRun("", objectUri)
            const worklist: AtcWorkList = await client.atcWorklists(runResult.id)

            interface Finding {
                priority: number
                checkTitle: string
                messageTitle: string
                uri: string
                location: string
            }

            const findings: Finding[] = worklist.objects.flatMap((o: any) =>
                o.findings.map((f: any) => ({
                    priority: f.priority,
                    checkTitle: f.checkTitle,
                    messageTitle: f.messageTitle,
                    uri: f.uri,
                    location: f.location
                }))
            )

            const summary = {
                object: structure.metaData["adtcore:name"],
                type: structure.metaData["adtcore:type"],
                totalFindings: findings.length,
                byPriority: {
                    priority1: findings.filter((f: Finding) => f.priority === 1).length,
                    priority2: findings.filter((f: Finding) => f.priority === 2).length,
                    priority3: findings.filter((f: Finding) => f.priority === 3).length
                },
                findings: findings.slice(0, 50)
            }

            const contentText = [
                JSON.stringify(summary, null, 2),
                `ATC check completed for ${structure.metaData["adtcore:name"]}: ${findings.length} finding(s).`,
                findings.length > 50 ? `Showing first 50 findings out of ${findings.length}.` : ""
            ].filter(Boolean)

            const content = contentText.map(t => new LanguageModelTextPart(t))
            return new LanguageModelToolResult(content)
        } catch (e) {
            return new LanguageModelToolResult([
                new LanguageModelTextPart(`Error running ATC check: ${String(e)}`)
            ])
        }
    }

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<RunAtcCheckInput>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation> {
        const uri = Uri.parse(options.input.url)
        const client = getClient(uri.authority)
        if (client)
            return {
                invocationMessage: `Running ATC check on ${uri.path.replace(/.*\//, "")}`
            }
        throw new Error(`No ABAP filesystem registered for ${uri.authority}`)
    }
}

// ==================== Get Dumps ====================

interface GetDumpsInput {
    url: string
    maxResults?: number
}

export class GetDumpsTool implements LanguageModelTool<GetDumpsInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<GetDumpsInput>,
        token: CancellationToken
    ): Promise<LanguageModelToolResult> {
        const { url, maxResults = 20 } = options.input
        const uri = Uri.parse(url)
        const client = getClient(uri.authority)

        try {
            // Use the dumps method - it returns DumpsFeed from the API
            const dumpsFeed = await client.dumps()
            const dumps = dumpsFeed.dumps || []

            interface DumpInfo {
                id: string
                text: string
                type: string
                author: string
                categories: string[]
            }

            const dumpList: DumpInfo[] = dumps.slice(0, maxResults).map((d: any) => ({
                id: d.id || "",
                text: d.text || "",
                type: d.type || "",
                author: d.author || "",
                categories: (d.categories || []).map((c: any) => c.label || c.term)
            }))

            const contentText = [
                JSON.stringify({ totalDumps: dumps.length, dumps: dumpList }, null, 2),
                `Found ${dumps.length} dump(s). Showing ${dumpList.length}.`,
                dumpList.length > 0 ? `**TIP**: Use the dump ID to look up more details in the ABAP system.` : "No recent dumps found."
            ]
            const content = contentText.map(t => new LanguageModelTextPart(t))
            return new LanguageModelToolResult(content)
        } catch (e) {
            return new LanguageModelToolResult([
                new LanguageModelTextPart(`Error getting dumps: ${String(e)}`)
            ])
        }
    }

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<GetDumpsInput>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation> {
        const uri = Uri.parse(options.input.url)
        const client = getClient(uri.authority)
        if (client)
            return {
                invocationMessage: `Fetching recent dumps from ${uri.authority}`
            }
        throw new Error(`No ABAP filesystem registered for ${uri.authority}`)
    }
}

// ==================== Get Object Revisions/History ====================

interface GetRevisionsInput {
    url: string
}

export class GetRevisionsTool implements LanguageModelTool<GetRevisionsInput> {
    async invoke(
        options: LanguageModelToolInvocationOptions<GetRevisionsInput>,
        token: CancellationToken
    ): Promise<LanguageModelToolResult> {
        const { url } = options.input
        const uri = Uri.parse(url)
        const client = getClient(uri.authority)

        try {
            const structure = await client.objectStructure(uri.path)
            const revisions = await client.revisions(structure.objectUrl)

            const revisionList = revisions.slice(0, 30).map(r => ({
                version: r.version,
                date: r.date,
                author: r.author,
                versionTitle: r.versionTitle
            }))

            const contentText = [
                JSON.stringify({
                    object: structure.metaData["adtcore:name"],
                    type: structure.metaData["adtcore:type"],
                    totalRevisions: revisions.length,
                    revisions: revisionList
                }, null, 2),
                `Found ${revisions.length} revision(s) for ${structure.metaData["adtcore:name"]}.`
            ]
            const content = contentText.map(t => new LanguageModelTextPart(t))
            return new LanguageModelToolResult(content)
        } catch (e) {
            return new LanguageModelToolResult([
                new LanguageModelTextPart(`Error getting revisions: ${String(e)}`)
            ])
        }
    }

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<GetRevisionsInput>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation> {
        const uri = Uri.parse(options.input.url)
        const client = getClient(uri.authority)
        if (client)
            return {
                invocationMessage: `Getting revision history for ${uri.path.replace(/.*\//, "")}`
            }
        throw new Error(`No ABAP filesystem registered for ${uri.authority}`)
    }
}
