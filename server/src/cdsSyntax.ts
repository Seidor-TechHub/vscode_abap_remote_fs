import { ABAPCDSLexer, ABAPCDSParser } from "abapcdsgrammar"
import {
  ANTLRInputStream,
  CommonTokenStream,
  ParserRuleContext,
  Token,
  ANTLRErrorListener,
  TokenSource
} from "antlr4ts"
import { ParseTree, ParseTreeListener, TerminalNode } from "antlr4ts/tree"
import { Position } from "vscode-languageserver"

export const isRuleContext = (tree: ParseTree): tree is ParserRuleContext =>
  !!(tree as any).start

export const isTerminal = (tree: ParseTree): tree is TerminalNode =>
  !!(tree as any).symbol

export const terminalType = (t: ParseTree) => isTerminal(t) && t.symbol.type

export const vscPosition = (line: number, character: number): Position => ({
  line: line - 1,
  character
})

const tokenStartPosition = (t: Token): Position =>
  vscPosition(t.line, t.charPositionInLine)

const tokenStopPosition = (t: Token): Position =>
  vscPosition(t.line, t.stopIndex - t.startIndex + t.charPositionInLine)

export const positionInToken = (p: Position, t: Token) => {
  const start = tokenStartPosition(t)
  const stop = tokenStopPosition(t)
  return (
    p.line === stop.line &&
    p.line === start.line &&
    p.character >= start.character &&
    p.character <= stop.character
  )
}

export function positionInContext(ctx: ParserRuleContext, position: Position) {
  const start = tokenStartPosition(ctx.start)
  const stop = tokenStopPosition(ctx.stop || ctx.start)

  if (start.line === stop.line)
    return (
      position.line === start.line &&
      position.character >= start.character &&
      position.character <= stop.character
    )
  if (start.line === position.line) return position.character >= start.character
  if (stop.line === position.line) return position.character <= stop.character
  return start.line < position.line && stop.line > position.line
}

export function findNode(
  ctx: ParserRuleContext,
  pos: Position
): ParserRuleContext | undefined {
  if (positionInContext(ctx, pos))
    if (ctx.children) {
      const child = ctx.children
        .filter(isRuleContext)
        .find(c => positionInContext(c, pos))
      const leaf = child && findNode(child, pos)
      return leaf || ctx
    } else return ctx
}

interface ParserConfig {
  tokenMiddleware?: (s: TokenSource) => TokenSource
  errorListener?: ANTLRErrorListener<Token>
  parserListener?: ParseTreeListener
}

// Silent error listener to suppress parser errors
class SilentErrorListener implements ANTLRErrorListener<Token> {
  syntaxError(): void {
    // Suppress all syntax errors
  }
}

const silentErrorListener = new SilentErrorListener()

export function parseCDS(source: string, config: ParserConfig = {}) {
  const { tokenMiddleware: mid, errorListener, parserListener } = config
  const inputStream = new ANTLRInputStream(source)
  const lexer = new ABAPCDSLexer(inputStream)

  const tokenStream = new CommonTokenStream(mid ? mid(lexer) : lexer)
  const parser = new ABAPCDSParser(tokenStream)

  // Remove default error listeners and add custom one if provided
  if (errorListener) {
    parser.removeErrorListeners()
    lexer.removeErrorListeners()
    parser.addErrorListener(errorListener)
    lexer.addErrorListener(errorListener)
  }

  if (parserListener) parser.addParseListener(parserListener)
  return parser.cdsddl()
}

const completionItemDetector = (
  notify: (ctx: ParserRuleContext, sources: string[]) => void
): ParseTreeListener => {
  const completionRules = new Set([
    ABAPCDSParser.RULE_data_source,
    ABAPCDSParser.RULE_field,
    ABAPCDSParser.RULE_case_operand
  ])
  let sources: string[] = []
  return {
    exitEveryRule: ctx => {
      if (completionRules.has(ctx.ruleIndex)) {
        if (ctx.start.type === ABAPCDSLexer.IDENTIFIER) {
          notify(ctx, sources)
          if (
            ctx.ruleIndex === ABAPCDSParser.RULE_data_source &&
            ctx.start.text
          )
            sources = [...sources, ctx.start.text]
        }
      }
      if (ctx.ruleIndex === ABAPCDSParser.RULE_view) sources = []
    }
  }
}

const sourceOrFieldCompletion = (
  cursor: Position,
  completeSource: (prefix: string) => void,
  completeField: (prefix: string, sources: string[]) => void
) => {
  const last = { line: cursor.line, character: cursor.character - 1 }
  return completionItemDetector((ctx, sources) => {
    if (positionInContext(ctx, last)) {
      const len = cursor.character - ctx.start.charPositionInLine
      if (ctx.ruleIndex === ABAPCDSParser.RULE_data_source) {
        if (len && ctx.start.text && positionInToken(last, ctx.start))
          completeSource(ctx.start.text.substr(0, len))
      } else if (len > 0) completeField(ctx.text.substr(0, len), sources)
    }
  })
}

export type MatchType = "NONE" | "FIELD" | "SOURCE"

export const cdsCompletionExtractor = (source: string, cursor: Position) => {
  const result = {
    prefix: "",
    sources: [] as string[],
    matched: "NONE" as MatchType
  }
  const parserListener = sourceOrFieldCompletion(
    cursor,
    prefix => {
      result.prefix = prefix
      result.matched = "SOURCE"
    },
    (prefix, src) => {
      result.prefix = prefix
      result.matched = "FIELD"
      result.sources = src
    }
  )
  parseCDS(source, { parserListener })
  return result
}

export interface CdsDefinitionResult {
  entityName: string
  fieldName?: string // Field name if navigating to a field
  objectType?: string // DDLS for data definition, TABL for tables, etc.
  navigationType: "entity" | "field" | "alias" // What kind of navigation
  aliasPosition?: Position // For alias navigation within same file
}

interface AliasMapping {
  alias: string
  entityName: string
  position: Position
}

/**
 * Build a map of aliases to their entity names and positions
 */
function buildAliasMap(source: string): AliasMapping[] {
  const aliases: AliasMapping[] = []
  const parserListener: ParseTreeListener = {
    exitEveryRule: ctx => {
      // Look for data sources with aliases
      if (ctx.ruleIndex === ABAPCDSParser.RULE_data_source && ctx.start) {
        const children = ctx.children || []
        if (children.length === 0) return

        // Get the entity name (first token/identifier)
        const entityName = ctx.start.text
        if (!entityName) return

        // Collect all identifiers and look for 'as' keyword
        const identifiers: Array<{ text: string, position: Position }> = []
        let foundAs = false
        let asIndex = -1

        for (let i = 0; i < children.length; i++) {
          const child = children[i]
          if (isTerminal(child) && child.symbol) {
            const text = child.symbol.text?.toLowerCase()
            if (text === "as") {
              foundAs = true
              asIndex = identifiers.length
            }
          } else if (isRuleContext(child) && child.start && child.start.text) {
            identifiers.push({
              text: child.start.text,
              position: tokenStartPosition(child.start)
            })
          }
        }

        // Determine alias based on pattern
        let alias = ""
        let aliasPosition: Position | undefined

        if (foundAs && asIndex >= 0 && identifiers.length > asIndex) {
          // Pattern: "entity as alias" - alias is after 'as'
          alias = identifiers[asIndex].text
          aliasPosition = identifiers[asIndex].position
        } else if (!foundAs && identifiers.length > 1) {
          // Pattern: "entity alias" (no 'as' keyword) - last identifier is alias
          alias = identifiers[identifiers.length - 1].text
          aliasPosition = identifiers[identifiers.length - 1].position
        } else if (identifiers.length === 1) {
          // No alias, just entity name - use entity position
          alias = identifiers[0].text
          aliasPosition = identifiers[0].position
        }

        // Store the alias mapping
        if (alias && aliasPosition) {
          aliases.push({ alias, entityName, position: aliasPosition })
        }
      }
    }
  }

  try {
    parseCDS(source, { parserListener, errorListener: silentErrorListener })
  } catch (e) {
    // Ignore parsing errors
  }

  return aliases
}

/**
 * Extract the entity or field name at cursor position for go-to-definition
 * Returns the name of the CDS entity, table, field, or alias being referenced
 */
/**
 * Extract the word at cursor position from source text
 * Returns the identifier at the cursor, useful when parser fails
 */
function extractWordAtCursor(source: string, cursor: Position): string | undefined {
  const lines = source.split('\n')
  if (cursor.line >= lines.length) return undefined

  const line = lines[cursor.line]
  if (cursor.character >= line.length) return undefined

  // Find word boundaries around cursor position
  let start = cursor.character
  let end = cursor.character

  // Move start backwards to find beginning of word
  while (start > 0 && /[a-zA-Z0-9_]/.test(line[start - 1])) {
    start--
  }

  // Move end forwards to find end of word
  while (end < line.length && /[a-zA-Z0-9_]/.test(line[end])) {
    end++
  }

  if (start < end) {
    return line.substring(start, end)
  }

  return undefined
}

export const cdsDefinitionExtractor = (
  source: string,
  cursor: Position
): CdsDefinitionResult | undefined => {
  // Build alias map first - we'll need it for fallback
  const aliasMap = buildAliasMap(source)

  try {
    const result = parseCDS(source, { errorListener: silentErrorListener })
    const node = findNode(result, cursor)
    if (!node || !node.start || !node.start.text) {
      // Fallback: extract word at cursor position
      const word = extractWordAtCursor(source, cursor)
      if (word) {
        const aliasEntry = aliasMap.find(a => a.alias.toLowerCase() === word.toLowerCase())
        if (aliasEntry) {
          const fallbackResult: CdsDefinitionResult = {
            entityName: aliasEntry.entityName,
            objectType: "DDLS/DF",
            navigationType: "alias",
            aliasPosition: aliasEntry.position
          }
          return fallbackResult
        }
      }
      return
    }

    // Check if we're on a data source (table/view reference in FROM/JOIN)
    if (node.ruleIndex === ABAPCDSParser.RULE_data_source) {
      const entityName = node.start.text
      const result: CdsDefinitionResult = { entityName, objectType: "DDLS/DF", navigationType: "entity" }
      return result
    }

    // Check if we're on a field reference
    if (node.ruleIndex === ABAPCDSParser.RULE_field) {
      const fieldText = node.text
      // Handle qualified field names like "entity.field" or "alias.field"
      const parts = fieldText.split(".")

      if (parts.length > 1) {
        const qualifier = parts[0]
        const fieldName = parts[1]

        // Determine cursor position within the field text
        const fieldStartChar = node.start.charPositionInLine
        const cursorOffset = cursor.character - fieldStartChar
        const dotPosition = fieldText.indexOf(".")

        // If cursor is before the dot, navigate to entity/alias
        if (cursorOffset <= dotPosition) {
          // Check if it's an alias
          const aliasEntry = aliasMap.find(a => a.alias === qualifier)
          if (aliasEntry) {
            const result: CdsDefinitionResult = {
              entityName: aliasEntry.entityName,
              objectType: "DDLS/DF",
              navigationType: "alias",
              aliasPosition: aliasEntry.position
            }
            return result
          }
          // Otherwise, it's a direct entity reference
          const result: CdsDefinitionResult = { entityName: qualifier, objectType: "DDLS/DF", navigationType: "entity" }
          return result
        } else {
          // Cursor is after the dot, navigate to field definition
          // Resolve alias to entity name if needed
          let entityName = qualifier
          const aliasEntry = aliasMap.find(a => a.alias === qualifier)
          if (aliasEntry) {
            entityName = aliasEntry.entityName
          }
          const result: CdsDefinitionResult = {
            entityName,
            fieldName,
            objectType: "DDLS/DF",
            navigationType: "field"
          }
          return result
        }
      } else {
        // Unqualified field - just the field name alone
        // Could try to find it in the data sources, but for now return undefined
        return undefined
      }
    }

    // Check if we're on an association
    if (node.ruleIndex === ABAPCDSParser.RULE_association) {
      const entityName = node.start.text
      return { entityName, objectType: "DDLS/DF", navigationType: "entity" }
    }

    // For any identifier token, check if it's an alias or entity
    if (node.start.type === ABAPCDSLexer.IDENTIFIER) {
      const identifier = node.start.text

      // Check if this identifier is an alias
      const aliasEntry = aliasMap.find(a => a.alias === identifier)
      if (aliasEntry) {
        const result: CdsDefinitionResult = {
          entityName: aliasEntry.entityName,
          objectType: "DDLS/DF",
          navigationType: "alias",
          aliasPosition: aliasEntry.position
        }
        return result
      }

      // Check if we're in a JOIN/FROM clause or in the field selection area
      const lines = source.split('\n')
      const currentLine = cursor.line < lines.length ? lines[cursor.line] : ""
      const isInJoinClause = /\b(join|from)\b/i.test(currentLine)

      // If NOT in JOIN/FROM clause, search for the table definition
      if (!isInJoinClause && identifier && identifier.length > 0) {
        const joinPattern = new RegExp(`\\b(join|from)\\s+${identifier}\\b`, 'i')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          const match = joinPattern.exec(line)
          if (match) {
            const matchIndex = match.index + match[1].length + 1
            const position: Position = { line: i, character: matchIndex }
            const joinResult: CdsDefinitionResult = {
              entityName: identifier,
              objectType: "DDLS/DF",
              navigationType: "alias",
              aliasPosition: position
            }
            return joinResult
          }
        }
      }

      // Otherwise treat as entity reference (external navigation)
      if (identifier && identifier.length > 0) {
        const result: CdsDefinitionResult = { entityName: identifier, objectType: "DDLS/DF", navigationType: "entity" }
        return result
      }
    }
  } catch (e) {
    // Try fallback even on error
  }

  // Final fallback: if nothing worked, try direct word extraction
  const word = extractWordAtCursor(source, cursor)
  if (word) {
    const aliasEntry = aliasMap.find(a => a.alias.toLowerCase() === word.toLowerCase())
    if (aliasEntry) {
      const fallbackResult: CdsDefinitionResult = {
        entityName: aliasEntry.entityName,
        objectType: "DDLS/DF",
        navigationType: "alias",
        aliasPosition: aliasEntry.position
      }
      return fallbackResult
    }

    // Determine if we're in the field selection area or in JOIN/FROM area
    const lines = source.split('\n')
    const currentLine = cursor.line < lines.length ? lines[cursor.line] : ""

    // Check if current line contains JOIN or FROM keywords (we're in the JOIN/FROM area)
    const isInJoinClause = /\b(join|from)\b/i.test(currentLine)

    // Only search for JOIN/FROM definition if we're NOT in a JOIN/FROM clause
    // (i.e., we're in the field selection list)
    if (!isInJoinClause) {
      const joinPattern = new RegExp(`\\b(join|from)\\s+${word}\\b`, 'i')

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const match = joinPattern.exec(line)
        if (match) {
          const matchIndex = match.index + match[1].length + 1 // Position after "join " or "from "
          const position: Position = { line: i, character: matchIndex }
          const joinResult: CdsDefinitionResult = {
            entityName: word,
            objectType: "DDLS/DF",
            navigationType: "alias",
            aliasPosition: position
          }
          return joinResult
        }
      }
    }

    // Check if it's a known entity name (simple heuristic - check if it looks like a table/view name)
    if (word.length > 0 && /^[a-zA-Z_][a-zA-Z0-9_]*$/i.test(word)) {
      const entityResult: CdsDefinitionResult = {
        entityName: word,
        objectType: "DDLS/DF",
        navigationType: "entity"
      }
      return entityResult
    }
  }

  return undefined
}
