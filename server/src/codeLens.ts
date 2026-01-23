import { CodeLensParams, CodeLens, Command } from "vscode-languageserver"
import { clientAndObjfromUrl } from "./utilities"
import { isAbap } from "./functions"

export async function codeLensHandler(params: CodeLensParams): Promise<CodeLens[]> {
    if (!isAbap(params.textDocument.uri)) return []
    const co = await clientAndObjfromUrl(params.textDocument.uri)
    if (!co) return []

    const lenses: CodeLens[] = []
    const lines = co.source.split('\n')
    const callScreenRegex = /CALL\s+SCREEN\s+['"]?(\d+)['"]?/i

    lines.forEach((line, index) => {
        const match = line.match(callScreenRegex)
        if (match) {
            const screenNumber = match[1]
            const startChar = match.index! + match[0].indexOf(match[1])
            const range = {
                start: { line: index, character: startChar },
                end: { line: index, character: startChar + screenNumber.length }
            }
            lenses.push({
                range,
                command: Command.create(
                    `Open screen ${screenNumber} in SAP GUI`,
                    'abapfs.openDynpro',
                    co.confKey,
                    co.obj.name,
                    screenNumber
                )
            })
        }
    })

    return lenses
}