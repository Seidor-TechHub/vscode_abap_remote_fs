import {
  CustomTextEditorProvider,
  TextDocument,
  WebviewPanel,
  CancellationToken,
  ExtensionContext,
  window,
  Webview,
  Uri,
  commands
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

interface DataElementInfo {
  name: string
  description: string
  typeKind: string
  domain: string
  dataType: string
  length: string
  decimals: string
  labels: {
    short: string
    medium: string
    long: string
    heading: string
  }
}

const extractDataElementInfo = (raw: any): DataElementInfo | undefined => {
    const wbobj = raw["blue:wbobj"] || raw["wbobj"]
    if (!wbobj) return undefined
    
    const dataElement = wbobj["dtel:dataElement"] || wbobj["dataElement"]
    if (!dataElement) return undefined

    const getVal = (obj: any, key: string) => {
        // try with and without namespace
        for(const k in obj) {
            if (k === key || k.endsWith(":" + key)) return obj[k]
        }
        return ""
    }
    
    const getAttr = (obj: any, key: string) => {
         for(const k in obj) {
            if (k === "@_" + key || k.endsWith(":" + key) && k.startsWith("@_")) return obj[k]
        }
        return ""
    }

    return {
        name: getAttr(wbobj, "name"),
        description: getAttr(wbobj, "description"),
        typeKind: getVal(dataElement, "typeKind"),
        domain: getVal(dataElement, "typeName"),
        dataType: getVal(dataElement, "dataType"),
        length: getVal(dataElement, "dataTypeLength"),
        decimals: getVal(dataElement, "dataTypeDecimals"),
        labels: {
            short: getVal(dataElement, "shortFieldLabel"),
            medium: getVal(dataElement, "mediumFieldLabel"),
            long: getVal(dataElement, "longFieldLabel"),
            heading: getVal(dataElement, "headingFieldLabel")
        }
    }
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
    panel.webview.onDidReceiveMessage(message => {
        if (message.command === 'openType') {
            commands.executeCommand('abapfs.searchObjectDirect', message.name)
        }
    })
    panel.webview.html = this.toHtml(panel.webview, document.getText())
  }
  private toHtml(webview: Webview, source: string) {
    const raw = parser.parse(source)
    const deInfo = extractDataElementInfo(raw)
    const content = raw["blue:wbobj"] || raw["wbobj"] || raw
    const data = flatten(content)
    
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

    let topSection = ""
    if (deInfo) {
        const domainLink = deInfo.typeKind === 'domain' 
            ? `<a href="#" onclick="openType('${deInfo.domain}')">${deInfo.domain}</a>` 
            : deInfo.domain;

        topSection = `
        <div class="summary">
            <h2>${deInfo.name}</h2>
            <div class="desc">${deInfo.description}</div>
            <div class="grid">
                <div class="label">Type Kind:</div><div>${deInfo.typeKind}</div>
                <div class="label">Domain:</div><div>${domainLink}</div>
                <div class="label">Data Type:</div><div>${deInfo.dataType}</div>
                <div class="label">Length:</div><div>${deInfo.length}</div>
                <div class="label">Decimals:</div><div>${deInfo.decimals}</div>
            </div>
            <h3>Field Labels</h3>
            <div class="grid">
                <div class="label">Short:</div><div>${deInfo.labels.short}</div>
                <div class="label">Medium:</div><div>${deInfo.labels.medium}</div>
                <div class="label">Long:</div><div>${deInfo.labels.long}</div>
                <div class="label">Heading:</div><div>${deInfo.labels.heading}</div>
            </div>
            <hr/>
        </div>`
    }

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
    <title>ABAP XML Object</title>
    <link href="${styleUri}" rel="stylesheet" />
    <style>
        .summary { margin-bottom: 20px; }
        .desc { color: var(--vscode-descriptionForeground); margin-bottom: 10px; font-size: 1.1em; }
        .grid { display: grid; grid-template-columns: 150px 1fr; gap: 5px; margin-bottom: 10px; }
        .label { font-weight: bold; color: var(--vscode-foreground); }
        h3 { margin-top: 15px; margin-bottom: 5px; }
    </style>
    <script>
        const vscode = acquireVsCodeApi();
        function openType(name) {
            vscode.postMessage({ command: 'openType', name: name });
        }
    </script>
    </head>
    <body>
    ${topSection}
    <h3>Raw Data</h3>
    <table><thead><tr><th>Property</th><th>Value</th></tr></thead>
    <tbody>${body}</tbody>
    </table></body></html>`
  }
}
