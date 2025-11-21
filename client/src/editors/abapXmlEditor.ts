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
import { XMLParser } from "fast-xml-parser"
import path from "path"

const parser = new XMLParser({
  parseAttributeValue: true,
  ignoreAttributes: false
})

const isObject = (x: any) => typeof x === "object" && x !== null && !Array.isArray(x)

const flatten = (obj: any, prefix = ""): { key: string; value: string }[] => {
  if (!isObject(obj)) return []
  
  let result: { key: string; value: string }[] = []
  
  for (const key in obj) {
    if (key.startsWith("atom:")) continue // Skip links
    if (key.startsWith("@_xmlns")) continue // Skip namespace definitions
    
    const value = obj[key]
    let cleanKey = key
    if (cleanKey.startsWith("@_")) {
        cleanKey = cleanKey.substring(2)
    }
    cleanKey = cleanKey.replace(/^[a-z0-9]+:/, "") // Remove namespace
    
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result.push({ key: prefix + cleanKey, value: String(value) })
    } else if (isObject(value)) {
      result = [...result, ...flatten(value, prefix + cleanKey + " / ")]
    } else if (Array.isArray(value)) {
        // Handle arrays if necessary, maybe join them or list them
        value.forEach((v, i) => {
             if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
                result.push({ key: `${prefix}${cleanKey}[${i}]`, value: String(v) })
             } else {
                 result = [...result, ...flatten(v, `${prefix}${cleanKey}[${i}] / `)]
             }
        })
    }
  }
  return result
}

const parseXmlContent = (source: string) => {
  const raw = parser.parse(source)
  // Use wbobj if available, otherwise raw
  const content = raw["blue:wbobj"] || raw["wbobj"] || raw
  
  return flatten(content)
}

export class AbapXmlEditorProvider implements CustomTextEditorProvider {
  public static register(context: ExtensionContext) {
    const provider = new AbapXmlEditorProvider(context)
    return window.registerCustomEditorProvider("abapfs.xml", provider)
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
    const header = `<tr><th>Property</th><th>Value</th></tr>`
    const data = parseXmlContent(source)
    
    const body = data
      .map(m => {
        return `<tr><td class="key">${m.key}</td>
          <td class="value">${m.value}</td>
          </tr>`
      })
      .join("\n")

    const styleUri = webview.asWebviewUri(
      Uri.file(
        path.join(this.context.extensionPath, "client/media", "editor.css")
      )
    )

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
    <title>ABAP XML Object</title>
    <link href="${styleUri}" rel="stylesheet" />
    </head>
    <body>
    <table><thead>${header}</thead>
    <tbody>${body}</tbody>
    </table></body></html>`
  }
}
