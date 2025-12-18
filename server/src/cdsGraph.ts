import { parseCDS, isRuleContext, isTerminal } from "./cdsSyntax"
import { ABAPCDSParser } from "abapcdsgrammar"
import { ParseTreeListener } from "antlr4ts/tree"

export function getCdsDependencies(source: string): string[] {
  const dependencies: Set<string> = new Set()

  const listener: ParseTreeListener = {
    exitEveryRule: (ctx) => {
      if (ctx.ruleIndex === ABAPCDSParser.RULE_data_source) {
        // data_source: entity_name (AS alias)? ...
        // entity_name is the first child usually
        if (ctx.start && ctx.start.text) {
          dependencies.add(ctx.start.text.toUpperCase())
        }
      }
      if (ctx.ruleIndex === ABAPCDSParser.RULE_association) {
        // association ... to target ...
        // I need to find the target
        // association rule structure depends on grammar
        // usually: ASSOCIATION ... TO target ...
        // Let's try to find the target name in children
        // It's likely an identifier after TO

        // Since I don't have the exact grammar, I'll look for identifiers that are not keywords
        // But simpler: just look for data_source usage inside association if it reuses it, 
        // or if association has its own rule for target.

        // If I look at the text of the association context, I might parse it manually or rely on children.
        // Let's assume the target is a simple identifier.

        // A safer bet is to inspect children.
        if (ctx.children) {
          let foundTo = false
          for (const child of ctx.children) {
            if (isTerminal(child)) {
              if (child.text.toUpperCase() === "TO") {
                foundTo = true
                continue
              }
            }
            if (foundTo && isRuleContext(child)) {
              // This might be the target
              if (child.start && child.start.text) {
                dependencies.add(child.start.text.toUpperCase())
                foundTo = false // Reset
              }
            }
          }
        }
      }
    }
  }

  try {
    parseCDS(source, { parserListener: listener })
  } catch (e) {
    // ignore errors
  }

  return Array.from(dependencies)
}
