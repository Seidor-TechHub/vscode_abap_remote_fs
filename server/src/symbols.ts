import { caughtToString, isAbap, parts } from "./functions"
import {
  DocumentSymbolParams,
  DocumentSymbol,
  SymbolKind,
  Range,
  TextDocuments
} from "vscode-languageserver"
import { TextDocument } from 'vscode-languageserver-textdocument'
import { clientAndObjfromUrl, rangeFromUri } from "./utilities"
import { ClassComponent, Link } from "abap-adt-api"
import { log } from "./clientManager"

const typeMap: Map<string, SymbolKind> = new Map([
  ["CLAS/I", SymbolKind.File],
  ["CLAS/OA", SymbolKind.Field],
  ["CLAS/OB", SymbolKind.Null], // alias
  ["CLAS/OC", SymbolKind.Class],
  ["CLAS/OCL", SymbolKind.Class],
  ["CLAS/OF", SymbolKind.Null], // friend
  ["CLAS/OLA", SymbolKind.Field],
  ["CLAS/OLD", SymbolKind.Method],
  ["CLAS/OND", SymbolKind.Method],
  ["CLAS/ON", SymbolKind.Method],
  ["CLAS/OO", SymbolKind.Method],
  ["CLAS/OLF", SymbolKind.TypeParameter],
  ["CLAS/OLN", SymbolKind.Interface],
  ["CLAS/OLT", SymbolKind.TypeParameter], // implementation, local
  ["CLAS/OK", SymbolKind.Null],
  ["CLAS/OM", SymbolKind.Method],
  ["CLAS/OR", SymbolKind.Interface], // implementation
  ["CLAS/OT", SymbolKind.TypeParameter],
  ["INTF/OI", SymbolKind.Interface],
  ["INTF/IO", SymbolKind.Method],
  ["INTF/IA", SymbolKind.Field],
  ["INTF/IT", SymbolKind.TypeParameter]
])

function parseAbapSymbols(document: TextDocument): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = []
  const text = document.getText()
  const lines = text.split(/\r?\n/)
  const stack: { symbol: DocumentSymbol, endPattern: RegExp }[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('*')) continue
    const code = line.split('"')[0] // ignore comments

    // Check for end of current container
    if (stack.length > 0) {
      const current = stack[stack.length - 1]
      if (current.endPattern.test(code)) {
        current.symbol.range.end = { line: i, character: line.length }
        current.symbol.selectionRange.end = { line: i, character: line.length }
        stack.pop()
        continue
      }
    }

    let match
    // FORM
    if (match = code.match(/^\s*FORM\s+(\S+)/i)) {
      const name = match[1]
      const symbol: DocumentSymbol = {
        name,
        kind: SymbolKind.Function,
        range: Range.create(i, 0, i, line.length),
        selectionRange: Range.create(i, match.index || 0, i, (match.index || 0) + match[0].length),
        children: []
      }
      if (stack.length > 0) {
        stack[stack.length - 1].symbol.children?.push(symbol)
      } else {
        symbols.push(symbol)
      }
      stack.push({ symbol, endPattern: /^\s*ENDFORM/i })
    }
    // MODULE
    else if (match = code.match(/^\s*MODULE\s+(\S+)/i)) {
      const name = match[1]
      const symbol: DocumentSymbol = {
        name,
        kind: SymbolKind.Function,
        range: Range.create(i, 0, i, line.length),
        selectionRange: Range.create(i, match.index || 0, i, (match.index || 0) + match[0].length),
        children: []
      }
      if (stack.length > 0) {
        stack[stack.length - 1].symbol.children?.push(symbol)
      } else {
        symbols.push(symbol)
      }
      stack.push({ symbol, endPattern: /^\s*ENDMODULE/i })
    }
    // CLASS DEFINITION
    else if (match = code.match(/^\s*CLASS\s+(\S+)\s+DEFINITION/i)) {
      const name = match[1]
      const symbol: DocumentSymbol = {
        name,
        kind: SymbolKind.Class,
        range: Range.create(i, 0, i, line.length),
        selectionRange: Range.create(i, match.index || 0, i, (match.index || 0) + match[0].length),
        children: []
      }
      if (stack.length > 0) {
        stack[stack.length - 1].symbol.children?.push(symbol)
      } else {
        symbols.push(symbol)
      }
      stack.push({ symbol, endPattern: /^\s*ENDCLASS/i })
    }
    // CLASS IMPLEMENTATION
    else if (match = code.match(/^\s*CLASS\s+(\S+)\s+IMPLEMENTATION/i)) {
      const name = match[1]
      const symbol: DocumentSymbol = {
        name,
        kind: SymbolKind.Class,
        range: Range.create(i, 0, i, line.length),
        selectionRange: Range.create(i, match.index || 0, i, (match.index || 0) + match[0].length),
        children: []
      }
      if (stack.length > 0) {
        stack[stack.length - 1].symbol.children?.push(symbol)
      } else {
        symbols.push(symbol)
      }
      stack.push({ symbol, endPattern: /^\s*ENDCLASS/i })
    }
    // METHOD
    else if (match = code.match(/^\s*METHOD\s+(\S+)/i)) {
      const name = match[1]
      const symbol: DocumentSymbol = {
        name,
        kind: SymbolKind.Method,
        range: Range.create(i, 0, i, line.length),
        selectionRange: Range.create(i, match.index || 0, i, (match.index || 0) + match[0].length),
        children: []
      }
      if (stack.length > 0) {
        stack[stack.length - 1].symbol.children?.push(symbol)
      } else {
        symbols.push(symbol)
      }
      stack.push({ symbol, endPattern: /^\s*ENDMETHOD/i })
    }
    // TYPES
    else if (match = code.match(/^\s*TYPES\s*:?\s*(\S+)/i)) {
      const name = match[1]
      // Avoid matching "TYPES: BEGIN OF" as a single type named "BEGIN" if possible, but for now simple regex
      if (name.toUpperCase() !== "BEGIN" && name.toUpperCase() !== "END") {
        const symbol: DocumentSymbol = {
          name,
          kind: SymbolKind.Struct,
          range: Range.create(i, 0, i, line.length),
          selectionRange: Range.create(i, match.index || 0, i, (match.index || 0) + match[0].length),
          children: []
        }
        if (stack.length > 0) {
          stack[stack.length - 1].symbol.children?.push(symbol)
        } else {
          symbols.push(symbol)
        }
      }
    }
    // DATA
    else if (match = code.match(/^\s*DATA\s*:?\s*(\S+)/i)) {
      const name = match[1]
      if (name.toUpperCase() !== "BEGIN" && name.toUpperCase() !== "END") {
        const symbol: DocumentSymbol = {
          name,
          kind: SymbolKind.Variable,
          range: Range.create(i, 0, i, line.length),
          selectionRange: Range.create(i, match.index || 0, i, (match.index || 0) + match[0].length),
          children: []
        }
        if (stack.length > 0) {
          stack[stack.length - 1].symbol.children?.push(symbol)
        } else {
          symbols.push(symbol)
        }
      }
    }
  }
  return symbols
}

function decodeType(comp: ClassComponent) {
  const adtType = comp["adtcore:type"]
  const mapped = typeMap.get(adtType)
  if (mapped === SymbolKind.Field && comp.constant) return SymbolKind.Constant
  if (mapped) return mapped

  log(
    "Unknown symbol type for",
    comp["adtcore:type"],
    comp["adtcore:name"],
    comp.links.length && comp.links[0].href
  )

  return SymbolKind.Null
}
function convertComponent(comp: ClassComponent, definition: boolean) {
  const dLink = comp.links.find(l => !!l.rel.match(/definitionIdentifier/i))
  const iLink = comp.links.find(l => !!l.rel.match(/implementationIdentifier/i))

  const mainLink = definition ? dLink : iLink
  const suffix =
    (definition && iLink && " definition") ||
    (!definition && dLink && " implementation") ||
    ""

  const range = mainLink && rangeFromUri(mainLink.href)
  if (range) {
    const selectionRange = range
    const name = comp["adtcore:name"] + suffix
    const kind = decodeType(comp)
    const children = comp.components
      .map(x => convertComponent(x, definition))
      .filter(x => x) as DocumentSymbol[]
    const symbol: DocumentSymbol = {
      range,
      name,
      kind,
      selectionRange,
      children
    }
    return symbol
  }
}

function filterComp(comp: ClassComponent, part: string): ClassComponent[] {
  const components: ClassComponent[] = []
  const linkfilter = (p: string) => (l: Link) => l.href.indexOf(p) >= 0
  const hasPart = (c: ClassComponent, p: string) =>
    !!c.links.find(linkfilter(p))
  const filterPart = (c: ClassComponent, p: string) => {
    const newc = { ...c }
    newc.links = c.links.filter(linkfilter(p))
    newc.components = c.components.reduce((acc, cur) => {
      acc.push(...filterComp(cur, p))
      return acc
    }, new Array<ClassComponent>())
    return newc
  }
  // if part found in comp, return comp but filter out all the non-matching links
  if (hasPart(comp, part)) components.push(filterPart(comp, part))
  else for (const c of comp.components) components.push(...filterComp(c, part))
  return components
}

export async function documentSymbols(params: DocumentSymbolParams, documents: TextDocuments<TextDocument>) {
  const symbols: DocumentSymbol[] = []
  try {
    if (!isAbap(params.textDocument.uri)) return
    const co = await clientAndObjfromUrl(params.textDocument.uri, false)
    if (!co) return
    // classes and interfaces have their own service/format
    if (co.obj.type.match("(CLAS)|(INTF)")) {
      const pattern = /((?:(?:\/source\/)|(?:\/includes\/)).*)/
      const [part] = parts(co.obj.url, pattern)
      const classUri = co.obj.url.replace(pattern, "")

      const component = await co.client.statelessClone.classComponents(classUri)
      const localComp = filterComp(component, part)

      for (const sym of localComp.map(c => convertComponent(c, true)))
        if (sym) symbols.push(sym)
      for (const sym of localComp.map(c => convertComponent(c, false)))
        if (sym) symbols.push(sym)
    } else {
      // For other types (PROG, FUGR, INCL), parse the document content
      const document = documents.get(params.textDocument.uri)
      if (document) {
        symbols.push(...parseAbapSymbols(document))
      }
    }
  } catch (e) {
    log("Exception in document symbol:", caughtToString(e)) // ignore
  }
  return symbols
}
