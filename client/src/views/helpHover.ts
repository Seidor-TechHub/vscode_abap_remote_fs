import { languages, Hover, MarkdownString, CancellationToken, Disposable } from "vscode"
import { ADTSCHEME, getClient } from "../adt/conections"
import { findAbapObject } from "../adt/operations/AdtObjectFinder"

const DEFAULT_DELAY = 500

function htmlToMarkdown(html: string): string {
  if (!html) return ""

  // remove head/style/script blocks (these often contain CSS that becomes visible when tags are stripped)
  let clean = html.replace(/<!--([\s\S]*?)-->/g, "")
  clean = clean.replace(/<head[\s\S]*?>[\s\S]*?<\/head>/gi, "")
  clean = clean.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
  clean = clean.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")

  // If the HTML contains raw CSS-like text (no tags), strip obvious CSS blocks/lines
  // Remove lines that look like CSS selectors or rules (contain '{' '}' or many ':' and ';')
  clean = clean
    .split(/\r?\n/)
    .map(line => {
      const l = line.trim()
      const cssLike = /\{.*\}|\}|\{/.test(l) || ((l.match(/:/g) || []).length >= 2 && l.indexOf(';') >= 0)
      return cssLike ? '' : line
    })
    .join('\n')

  // now convert useful elements to Markdown. Keep it conservative to look native in VS Code.
  // Convert common block elements to newlines so structure is preserved
  clean = clean.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => '- ' + stripTags(inner).trim() + '\n')
  clean = clean.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, c) => {
    const code = decodeHtmlEntities(c)
    return "\n```abap\n" + code + "\n```\n"
  })
  clean = clean.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, c) => "`" + decodeHtmlEntities(c) + "`")
  clean = clean.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t) => "# " + stripTags(t).trim() + "\n")
  clean = clean.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => "## " + stripTags(t).trim() + "\n")
  clean = clean.replace(/<h[3-6][^>]*>([\s\S]*?)<\/h[3-6]>/gi, (_m, t) => "### " + stripTags(t).trim() + "\n")
  clean = clean.replace(/<(p|div|tr)[^>]*>/gi, '')
  clean = clean.replace(/<br\s*\/?\s*>/gi, '\n')

  // links
  clean = clean.replace(/<a[^>]*href=("|')([^"']+)("|')[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href, _q2, text) => {
    const t = stripTags(text).trim()
    return `[${t}](${href})`
  })

  // simple tables: convert HTML tables to markdown-style pipes
  clean = clean.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, table) => {
    const rows = table.replace(/<thead[\s\S]*?>[\s\S]*?<\/thead>/gi, "").match(/<tr[\s\S]*?>[\s\S]*?<\/tr>/gi) || []
    const out: string[] = []
    for (const r of rows) {
      const matches = Array.from(r.matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi)) as RegExpMatchArray[]
      const cols = matches.map(m => (m && m[2]) ? m[2] : "")
      const cells = cols.map(c => stripTags(c).trim().replace(/\s+/g, " "))
      if (cells.length) out.push(`| ${cells.join(' | ')} |`)
    }
    // If there is at least one row and more than one column, add a separator after header
    if (out.length > 1) {
      const colsCount = out[0]!.split('|').length - 2
      const sep = `| ${Array(colsCount).fill('---').join(' | ')} |`
      return [out[0], sep].concat(out.slice(1)).join('\n')
    }
    return out.join('\n')
  })

  // remove any remaining tags
  clean = clean.replace(/<[^>]+>/g, "")

  // decode entities
  clean = decodeHtmlEntities(clean)

  // reduce long runs of spaces but keep meaningful line breaks
  clean = clean.replace(/[ \t]{2,}/g, ' ')

  // collapse multiple blank lines
  clean = clean.replace(/\n{3,}/g, "\n\n")

  // If the content looks like a simple pipe table (no HTML), keep it formatted
  // e.g., "| Name | Type | Length | Content |" should remain as table
  const lines = clean.split(/\r?\n/)
  const outLines: string[] = []
  for (const line of lines) {
    if (/^\|.*\|$/.test(line.trim())) {
      outLines.push(line.trim())
    } else {
      outLines.push(line)
    }
  }
  clean = outLines.join('\n')

  // final post-processing to make it look more native in VS Code
  return postProcessMarkdown(clean.trim())
}

function postProcessMarkdown(md: string): string {
  if (!md) return md

  const sqlKeywords = ["SELECT", "ENDSELECT", "INTO", "APPENDING", "UP TO", "OFFSET", "WHERE", "FROM", "GROUP BY", "ORDER BY", "UNION"]

  const lines = md.split(/\r?\n/)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    // trim trailing/trailing spaces but preserve indentation inside code blocks
    const t = line.trim()

    // Detect section headings: short all-caps lines or known labels
    if (t && t.length <= 60 && t === t.toUpperCase() && /[A-Z]/.test(t)) {
      out.push(`## ${t}`)
      i++
      continue
    }

    // Known section names
    if (/^(Short Reference|Syntax|Effect|ABAP target objects|Restricting the result set|ABAP-specific additions)$/i.test(t)) {
      out.push(`### ${t}`)
      i++
      continue
    }

    // Detect SQL/code blocks: if current line contains a SQL keyword, collect contiguous non-empty lines
    const hasSqlKeyword = sqlKeywords.some(k => new RegExp(`\\b${k}\\b`, 'i').test(t))
    if (hasSqlKeyword) {
      const block: string[] = []
      while (i < lines.length && (lines[i] ?? '').trim().length > 0) {
        block.push(lines[i] ?? '')
        i++
      }
      // normalize indentation inside code block
      const minIndent = block.reduce((min, l) => {
        const m = l.match(/^\s*/)
        const len = m ? m[0].length : 0
        return min === -1 ? len : Math.min(min, len)
      }, -1)
      const normalized = block.map(l => (minIndent > 0 ? l.slice(minIndent) : l)).join('\n')
      out.push('```abap')
      out.push(normalized)
      out.push('```')
      // skip possible blank line consumed below
      if (i < lines.length && (lines[i] ?? '').trim() === '') i++
      continue
    }

    // Simple list items already start with '- '
    out.push(line)
    i++
  }

  // Ensure spacing between headings and following content
  const result = out.join('\n').replace(/(## .*|### .*)\n(?!\n)/g, (m) => m.replace(/\n$/, '\n\n'))
  return result
}

function stripTags(s: string) {
  return s.replace(/<[^>]+>/g, "")
}

function decodeHtmlEntities(str: string) {
  return str.replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export function registerHover(): Disposable {
  const provider = languages.registerHoverProvider(
    { language: "abap", scheme: ADTSCHEME },
    {
      async provideHover(document, position, token: CancellationToken) {
        // small delay so we don't trigger on accidental mouse overs
        await new Promise<void>(resolve => setTimeout(() => resolve(), DEFAULT_DELAY))
        if (token.isCancellationRequested) return undefined

        const uri = document.uri
        // only support ADT scheme
        if (uri.scheme !== ADTSCHEME) return undefined

        try {
          const client = getClient(uri.authority)
          const obj = await findAbapObject(uri)
          if (!obj) return undefined

          const doc = await client.abapDocumentation(
            obj.path,
            document.getText(),
            position.line + 1,
            position.character + 1
          )

          if (!doc) return undefined

          // first try: convert to Markdown for a native look
          const converted = htmlToMarkdown(doc)

          // If conversion produced a single long block (likely failed) or contains suspicious binary/base64,
          // fall back to rendering the original HTML body (strip scripts for safety but keep styles)
          const looksBad = (() => {
            if (!converted) return true
            const lines = converted.split(/\r?\n/)
            if (lines.length <= 2 && converted.length > 200) return true
            // base64-like chunk detection
            if (/(?:[A-Za-z0-9+/]{40,})/.test(converted)) return true
            return false
          })()

          if (!looksBad) {
            const md = new MarkdownString(converted)
            md.isTrusted = true
            md.supportHtml = false
            return new Hover(md)
          }

          // fallback: render original HTML body (keep styles, remove scripts and head to avoid script execution)
          let body = doc
          // extract body if present
          const bodyMatch = doc.match(/<body[^>]*>([\s\S]*)<\/body>/i)
          if (bodyMatch && bodyMatch[1]) body = bodyMatch[1]
          // remove scripts
          body = body.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
          // remove comments
          body = body.replace(/<!--([\s\S]*?)-->/g, "")

          const md = new MarkdownString(body)
          md.isTrusted = true
          // allow simple HTML rendering inside hover so CSS in the documentation is preserved
          // this keeps the original look instead of showing raw CSS/text
          // note: avoid enabling scripts — we've stripped them above
          // @ts-ignore - some VS Code versions expose supportHtml
          md.supportHtml = true
          return new Hover(md)
        } catch (err) {
          return undefined
        }
      }
    }
  )
  return provider
}
