import {
  CustomTextEditorProvider,
  TextDocument,
  WebviewPanel,
  CancellationToken,
  ExtensionContext,
  window,
  Webview,
  Uri
} from "vscode"
import path from "path"

interface TableField {
  name: string
  type: string
  isKey: boolean
  notNull: boolean
  foreignKey?: string
}

interface TableDefinition {
  name: string
  description: string
  fields: TableField[]
}

const parseTableDefinition = (source: string): TableDefinition => {
  const lines = source.split("\n")
  let name = ""
  let description = ""
  const fields: TableField[] = []

  let currentField: TableField | undefined

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw === undefined || raw === null) continue
    const line = raw.trim()
    if (!line) continue

    // Table description
    if (line.startsWith("@EndUserText.label")) {
      const match = line.match(/@EndUserText\.label\s*:\s*'([^']+)'/)
      if (match && match[1]) description = match[1]
      continue
    }

    // Table name
    if (line.match(/^define\s+(table|structure|view)\s+/i)) {
      const match = line.match(/^define\s+(?:table|structure|view)\s+(\w+)/i)
      if (match && match[1]) name = match[1]
      continue
    }

    // Field definition
    // key mandt : mandt not null
    // matnr : matnr
    const fieldMatch = line.match(/^(key\s+)?(\w+)\s*:\s*(\w+)(\s+not\s+null)?/i)
    if (fieldMatch && fieldMatch[2] && fieldMatch[3]) {
      const field = {
        isKey: !!fieldMatch[1],
        name: fieldMatch[2],
        type: fieldMatch[3],
        notNull: !!fieldMatch[4]
      }
      currentField = field
      fields.push(field)
      continue
    }

    // Foreign key
    // with foreign key [0..*,1] t000
    if (currentField && line.match(/^with foreign key/i)) {
        const fkMatch = line.match(/with foreign key\s*(?:\[[^\]]+\])?\s*(\w+)/i)
        if (fkMatch && fkMatch[1]) {
            currentField.foreignKey = fkMatch[1]
        }
    }
  }

  return { name, description, fields }
}

export class AbapTableEditorProvider implements CustomTextEditorProvider {
  public static register(context: ExtensionContext) {
    const provider = new AbapTableEditorProvider(context)
    return window.registerCustomEditorProvider("abapfs.table", provider)
  }
  constructor(private context: ExtensionContext) { }
  resolveCustomTextEditor(
    document: TextDocument,
    panel: WebviewPanel,
    token: CancellationToken
  ) {
    panel.webview.options = { enableScripts: true, enableCommandUris: true }
    panel.webview.html = this.toHtml(panel.webview, document.getText())
  }
  private toHtml(webview: Webview, source: string) {
    const def = parseTableDefinition(source)
    
    const rows = def.fields
      .map(f => {
        return `<tr>
          <td>${f.name}</td>
          <td class="center">${f.isKey ? "\u2713" : ""}</td>
          <td>${f.type}</td>
          <td class="center">${f.notNull ? "\u2713" : ""}</td>
          <td>${f.foreignKey || ""}</td>
          </tr>`
      })
      .join("\n")

    const styleUri = webview.asWebviewUri(
      Uri.file(
        path.join(this.context.extensionPath, "client/media", "editor.css")
      )
    )

    if (def.fields.length === 0) {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
        <title>Table ${def.name}</title>
        <link href="${styleUri}" rel="stylesheet" />
        </head>
        <body>
        <p>No table definition found in this file.</p>
        </body></html>`
    }

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
    <title>Table ${def.name}</title>
    <link href="${styleUri}" rel="stylesheet" />
    <style>
        .center { text-align: center; }
        h2 { margin-bottom: 5px; }
        .desc { color: var(--vscode-descriptionForeground); margin-bottom: 20px; }
    </style>
    </head>
    <body>
    <h2>${def.name}</h2>
    <div class="desc">${def.description}</div>
    <table>
    <thead>
        <tr>
            <th>Field</th>
            <th>Key</th>
            <th>Type</th>
            <th>Not Null</th>
            <th>Foreign Key</th>
        </tr>
    </thead>
    <tbody>${rows}</tbody>
    </table></body></html>`
  }
}
