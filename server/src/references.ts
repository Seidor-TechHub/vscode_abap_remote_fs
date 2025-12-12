import {
  TextDocumentPositionParams,
  Location,
  ReferenceParams,
  CancellationToken,
  Position,
  CancellationTokenSource
} from "vscode-languageserver"
import { sourceRange, clientAndObjfromUrl } from "./utilities"
import {
  ReferenceUri,
  Location as ApiLocation,
  ADTClient,
  ClassComponent,
  UsageReference
} from "abap-adt-api"
import { vscUrl } from "./objectManager"
import { groupBy } from "lodash"
import { log, warn } from "./clientManager"
import { getObjectSource, setSearchProgress } from "./clientapis"
import { isAbap, memoize, parts, toInt, hashParms, caughtToString, isCdsView } from "./functions"
import { cdsDefinitionExtractor } from "./cdsSyntax"

async function findCdsDefinition(params: TextDocumentPositionParams) {
  try {
    const co = await clientAndObjfromUrl(params.textDocument.uri)
    if (!co) {
      return
    }

    // Extract the entity/table name at cursor position
    const defResult = cdsDefinitionExtractor(co.source, params.position)
    if (!defResult || !defResult.entityName) {
      return
    }

    // Handle alias navigation (within same file)
    if (defResult.navigationType === "alias" && defResult.aliasPosition) {
      const location = {
        uri: params.textDocument.uri,
        range: {
          start: defResult.aliasPosition,
          end: defResult.aliasPosition
        }
      } as Location
      return location
    }

    const entityName = defResult.entityName.toUpperCase()
    
    // Try to find the object - could be another CDS view (DDLS) or a table (TABL)
    // First try DDLS (CDS views)
    let objUri = ""
    let objectType = ""
    try {
      const searchResults = await co.client.statelessClone.searchObject(
        entityName,
        "DDLS/DF"
      )
      // Find exact match
      const exactMatch = searchResults.find(
        r => r["adtcore:name"].toUpperCase() === entityName
      )
      if (exactMatch) {
        objUri = exactMatch["adtcore:uri"]
        objectType = exactMatch["adtcore:type"]
      }
    } catch (e) {
      // Ignore search errors
    }

    // If not found as DDLS, try as table/view
    if (!objUri) {
      try {
        const searchResults = await co.client.statelessClone.searchObject(
          entityName,
          "" // Search all types
        )
        // Look for tables, views, or other database objects
        const exactMatch = searchResults.find(
          r =>
            r["adtcore:name"].toUpperCase() === entityName &&
            (r["adtcore:type"] === "TABL/DT" ||
              r["adtcore:type"] === "VIEW/DV" ||
              r["adtcore:type"] === "DDLS/DF")
        )
        if (exactMatch) {
          objUri = exactMatch["adtcore:uri"]
          objectType = exactMatch["adtcore:type"]
        }
      } catch (e) {
        // Ignore search errors
      }
    }

    if (!objUri) {
      return
    }

    // Convert ADT URI to VS Code URI
    const uri = await vscUrl(co.confKey, objUri, true)
    if (!uri) {
      return
    }

    // Get the source to determine the range
    const s = await getObjectSource(uri)
    if (!s) {
      return
    }

    // If navigating to a field, try to find it in the source
    if (defResult.navigationType === "field" && defResult.fieldName) {
      const fieldName = defResult.fieldName.toLowerCase()
      const lines = s.source.split("\n")
      
      // Search for field definition
      // For tables: look for the field name
      // For CDS views: look for field in the select list or associations
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase()
        
        // Try different patterns for field definitions
        const patterns = [
          new RegExp(`^\s*${fieldName}\s`, "i"),           // field at line start
          new RegExp(`^\s*key\s+${fieldName}\s`, "i"),     // key field
          new RegExp(`[,\s]${fieldName}\s*[,;]`, "i"),     // field with comma or semicolon
          new RegExp(`[,\s]${fieldName}\s+as\s+`, "i"),    // field with alias
          new RegExp(`\.${fieldName}\s*[,;\s]`, "i")       // qualified field like entity.field
        ]
        
        for (const pattern of patterns) {
          if (pattern.test(line)) {
            const character = line.indexOf(fieldName.toLowerCase())
            if (character >= 0) {
              return {
                uri: s.url,
                range: {
                  start: { line: i, character },
                  end: { line: i, character: character + fieldName.length }
                }
              } as Location
            }
          }
        }
      }
      
      // If field not found in source, still navigate to the file
      log(`Field ${defResult.fieldName} not found in ${entityName}, navigating to file start`)
    }

    // Return location at the beginning of the file
    const l: Location = {
      uri: s.url,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
      }
    }
    return l
  } catch (e) {
    log("Exception in CDS find definition:", caughtToString(e))
  }
}

export async function findDefinition(
  impl: boolean,
  params: TextDocumentPositionParams
) {
  const uri = params.textDocument.uri
  
  // Check if this is a CDS view
  if (isCdsView(uri)) {
    return findCdsDefinition(params)
  }
  
  // Handle ABAP files
  if (!isAbap(uri)) return
  
  try {
    const co = await clientAndObjfromUrl(uri)
    if (!co) return

    const range = sourceRange(
      co.source,
      params.position.line + 1,
      params.position.character
    )
    const result = await co.client.statelessClone.findDefinition(
      co.obj.mainUrl,
      co.source,
      range.start.line + 1,
      range.start.character,
      range.end.character,
      impl,
      co.obj.mainProgram || ""
    )

    if (!result.url) return

    let targetUri
    let source = ""
    if (result.url === co.obj.url) {
      // same file
      targetUri = uri
      source = co.source
    } else {
      targetUri = await vscUrl(co.confKey, result.url, true) // ask for new file's url
      if (!targetUri) return
      const s = await getObjectSource(targetUri)
      if (!s) return
      targetUri = s.url
      source = s.source
    }

    const l: Location = {
      uri: targetUri,
      range: sourceRange(source, result.line, result.column)
    }
    return l
  } catch (e) {
    log("Exception in find definition:", caughtToString(e)) // ignore
  }
}

class LocationManager {
  private classes: (uri: string) => Promise<ClassComponent>
  private sources: (uri: string) => Promise<string>
  private sections = new Map([
    ["CLAS/OSI", /^(?:(?=[^*"])[^"]*)?private\s+section(?:\s|\n|\.)/i],
    ["CLAS/OSO", /^(?:(?=[^*"])[^"]*)?protected\s+section(?:\s|\n|\.)/i]
  ])

  constructor(private conKey: string, private client: ADTClient) {
    this.classes = memoize(c => this.client.statelessClone.classComponents(c))
    this.sources = memoize(c => this.client.statelessClone.getObjectSource(c))
  }

  public async locationFromUrl(url: ReferenceUri) {
    if (url && url.start && url.uri) {
      const { uri, start, end, type, name } = url
      if (type && name) {
        let include
        try {
          include = await this.findInclude(name, type, uri)
        } catch (e) {
          return
        }
        if (include) {
          const link = this.findLink(include)
          if (link) {
            const [blockstart] = parts(link.href, /#.*start=([\d]+)/)
            if (blockstart) {
              const ofs = toInt(blockstart) - (start.line > 0 ? 1 : 0)
              start.line += ofs
              if (end) end.line += ofs
            }
          }
        } else {
          const reg = this.sections.get(type)
          if (!reg) return
          const ofs = await this.findLine(reg, uri)
          if (!ofs) return
          start.line += ofs
          if (end) end.line += ofs
        }
      }
      const includeUri = await vscUrl(this.conKey, uri)
      return {
        uri: includeUri,
        range: {
          start: this.convertLocation(start),
          end: this.convertLocation(end || start)
        }
      } as Location
    }
  }
  public async locationFromRef(ref: UsageReference) {
    const objtype = ref["adtcore:type"]
    if (objtype && objtype.match(/(clas)|(intf)/i)) {
      const { type, name } = hashParms(ref.uri)
      const uri = ref.uri.replace(/[#\?].*/, "")
      return this.locationFromUrl({
        uri,
        type: type || objtype,
        name: name || ref["adtcore:name"],
        start: { line: 0, column: 0 }
      })
    }
  }
  private async findLine(reg: RegExp, uri: string) {
    // hack for protected and private in older systems
    if (reg) {
      const source = await this.sources(uri)
      const lines = source.split("\n")
      for (const idx in lines) {
        if (lines[idx].match(reg)) return toInt(idx)
      }
    }
    return 0
  }

  private findLink(include: ClassComponent) {
    const link = include.links.find(
      l => !!(l.rel && l.href && l.rel.match("implementationBlock"))
    )
    if (link) return link
    return include.links.find(
      l => !!(l.rel && l.href && l.rel.match("definitionBlock"))
    )
  }

  private async findInclude(name: string, type: string, uri: string) {
    let include
    if (type && name) {
      const match = uri.match(
        /(\/sap\/bc\/adt\/oo\/(?:classes|interfaces)\/.*)\/source\/main/
      )
      if (match) {
        const main = await this.classes(match[1])
        if (main) {
          include = main.components.find(
            c => c["adtcore:name"] === name && c["adtcore:type"] === type
          )
          // hack for method references in older systems
          if (!include && type === "CLAS/OM")
            include = main.components.find(
              c => c["adtcore:name"] === name && c["adtcore:type"] === "CLAS/OO"
            )
        }
      }
    }
    return include
  }

  private convertLocation = (l: ApiLocation): Position => ({
    line: l.line - 1,
    character: l.column
  })
}

const fullname = (usageReference: UsageReference) => {
  const rparts = usageReference.objectIdentifier.split(";")
  return rparts[1] && rparts[0] === "ABAPFullName" ? rparts[1] : ""
}

let lastSearch: CancellationTokenSource | undefined
export function cancelSearch() {
  if (lastSearch) {
    lastSearch.cancel()
    lastSearch = undefined
    return setSearchProgress({ ended: true, hits: 0, progress: 100 }).catch(() => { })
  }
}

async function startSearch() {
  await cancelSearch()
  await setSearchProgress({ ended: false, hits: 0, progress: 0 })
  lastSearch = new CancellationTokenSource()
  return lastSearch
}
export async function findReferences(
  params: ReferenceParams,
  token: CancellationToken
) {
  if (!isAbap(params.textDocument.uri)) return
  const mySearch = await startSearch()
  const cancelled = () =>
    mySearch.token.isCancellationRequested || token.isCancellationRequested

  const locations: Location[] = []
  try {
    const co = await clientAndObjfromUrl(params.textDocument.uri, false)
    if (!co) return
    const manager = new LocationManager(co.confKey, co.client)
    const references = await co.client.statelessClone.usageReferences(
      co.obj.mainUrl,
      params.position.line + 1,
      params.position.character
    )
    if (cancelled()) return locations

    const goodRefs = references.filter(fullname)
    const groups = groupBy(goodRefs, fullname)

    let processed = 0
    for (const group of Object.keys(groups)) {
      try {
        const snippets = await co.client.statelessClone.usageReferenceSnippets(groups[group])
        for (const s of snippets) {
          if (s.snippets.length === 0) {
            const ref = references.find(
              r => r.objectIdentifier === s.objectIdentifier
            )
            if (ref)
              try {
                const loc = await manager.locationFromRef(ref)
                if (loc) locations.push(loc)
              } catch (e) {
                warn("no reference found for", s.objectIdentifier) // ignore
              }
          }
          for (const sn of s.snippets) {
            if (cancelled()) return locations
            const location = await manager.locationFromUrl(sn.uri)
            if (location && !location.uri)
              location.uri = await vscUrl(co.confKey, sn.uri.uri).catch(() => "")
            if (location && location.uri) locations.push(location)
            else warn("no reference found for", s.objectIdentifier, sn.uri.uri)
          }
        }
      } catch (e) {
        warn("Exception in reference search:", caughtToString(e)) // ignore
      }
      processed = processed + groups[group].length
      if (!cancelled()) {
        setSearchProgress({
          ended: processed === goodRefs.length,
          hits: locations.length,
          progress: (processed / goodRefs.length) * 100
        })
      }
    }
  } catch (e) {
    warn("Exception in reference search:", caughtToString(e)) // ignore
  }
  cancelSearch() // just for cleanup
  return locations
}
