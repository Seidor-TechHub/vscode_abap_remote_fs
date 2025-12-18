import { window, ViewColumn, Uri, commands } from "vscode"
import { Methods, CdsGraphRequest, CdsGraphResponse } from "vscode-abap-remote-fs-sharedapi"
import { client } from "../langClient"
import { getClient, getRoot } from "../adt/conections"
import { isAbapFile } from "abapfs"
import { AbapFsCommands } from "./registry"
import { command } from "./registry"
import { openObject } from "./commands"

interface GraphNode {
    name: string
    type: string
    children: string[]
}

// Helper to run promises with limited concurrency
async function parallelLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    const executing: Promise<void>[] = []
    
    for (const item of items) {
        const p = fn(item).then(() => {
            executing.splice(executing.indexOf(p), 1)
        })
        executing.push(p)
        
        if (executing.length >= limit) {
            await Promise.race(executing)
        }
    }
    
    await Promise.all(executing)
}

export class CdsDiagramCommands {
    @command(AbapFsCommands.showCdsDiagram)
    public async showCdsDiagram() {
        const editor = window.activeTextEditor
        if (!editor) return
        const doc = editor.document

        // Simple check for CDS
        if (!doc.fileName.endsWith(".asddls") && !doc.getText().match(/define\s+view/i)) {
            window.showErrorMessage("Not a CDS view")
            return
        }

        const confKey = doc.uri.authority
        const adtClient = getClient(confKey)
        if (!adtClient) return
        const root = getRoot(confKey)

        const graph: Map<string, GraphNode> = new Map()
        const processed = new Set<string>()
        const processing = new Set<string>() // Track in-flight requests
        
        // Cache for search results to avoid duplicate searches
        const searchCache = new Map<string, any>()
        
        const searchObjectCached = async (name: string) => {
            if (searchCache.has(name)) {
                return searchCache.get(name)
            }
            const result = await adtClient.searchObject(name, "")
            searchCache.set(name, result)
            return result
        }

        const processNode = async (name: string, source: string, depth: number): Promise<void> => {
            if (depth > 3 || processed.has(name) || processing.has(name)) return
            processing.add(name)

            try {
                const response = await client.sendRequest(Methods.cdsGraph, { source } as CdsGraphRequest) as CdsGraphResponse
                const children = response.dependencies || []

                graph.set(name, { name, type: 'CDS', children })
                processed.add(name)

                // Filter out already processed children
                const newChildren = children.filter(child => !processed.has(child) && !processing.has(child))
                
                if (newChildren.length === 0) return

                // Process children in parallel with concurrency limit
                const CONCURRENCY_LIMIT = 5
                
                // First, batch search all children in parallel (searches are lightweight)
                const searchPromises = newChildren.map(async (child) => {
                    try {
                        const searchResults = await searchObjectCached(child)
                        return { child, searchResults }
                    } catch (e) {
                        return { child, searchResults: null }
                    }
                })
                
                const searchResults = await Promise.all(searchPromises)
                
                // Then process each child with source reading in parallel with concurrency limit
                await parallelLimit(searchResults, CONCURRENCY_LIMIT, async ({ child, searchResults }) => {
                    if (processed.has(child) || processing.has(child)) return
                    
                    try {
                        if (searchResults && searchResults.length > 0) {
                            const hit = searchResults[0]
                            if (hit) {
                                const node = await root.findByAdtUri(hit["adtcore:uri"])
                                if (node && isAbapFile(node.file)) {
                                    const childSource = await node.file.read()
                                    await processNode(child, childSource, depth + 1)
                                } else {
                                    graph.set(child, { name: child, type: 'Unknown', children: [] })
                                    processed.add(child)
                                }
                            }
                        } else {
                            graph.set(child, { name: child, type: 'Unknown', children: [] })
                            processed.add(child)
                        }
                    } catch (e) {
                        console.error(`Failed to process ${child}`, e)
                        graph.set(child, { name: child, type: 'Unknown', children: [] })
                        processed.add(child)
                    }
                })
            } catch (e) {
                console.error(`Failed to get graph for ${name}`, e)
            } finally {
                processing.delete(name)
            }
        }

        await window.withProgress({
            location: 15, // Notification
            title: "Generating CDS Diagram..."
        }, async () => {
            // Use "ROOT" or try to extract name. For now "ROOT" is fine as the starting point label
            // But better to use the file name without extension
            const rootName = doc.uri.path.split('/').pop()?.split('.')[0] || "ROOT"
            await processNode(rootName.toUpperCase(), doc.getText(), 0)
        })

        let mermaid = "graph TD;\n"
        const nodeMapping: Record<string, string> = {}
        for (const [name, node] of graph) {
            // Sanitize names for mermaid
            const safeName = name.replace(/[^a-zA-Z0-9_]/g, '_')
            nodeMapping[safeName] = name
            mermaid += `  click ${safeName} callNodeClick\n`
            for (const child of node.children) {
                const safeChild = child.replace(/[^a-zA-Z0-9_]/g, '_')
                nodeMapping[safeChild] = child
                mermaid += `  ${safeName} --> ${safeChild};\n`
                mermaid += `  click ${safeChild} callNodeClick\n`
            }
        }

        const panel = window.createWebviewPanel(
            'cdsDiagram',
            'CDS Diagram',
            ViewColumn.One,
            { enableScripts: true }
        )

        panel.webview.onDidReceiveMessage(async message => {
            if (message.type === 'open') {
                const name = message.name
                try {
                    const searchResults = await adtClient.searchObject(name, "")
                    if (searchResults && searchResults.length > 0) {
                        const hit = searchResults.find(r => r["adtcore:name"] === name) || searchResults[0]
                        if (hit) {
                            await openObject(confKey, hit["adtcore:uri"])
                        }
                    }
                } catch (e) {
                    window.showErrorMessage(`Failed to open ${name}: ${e}`)
                }
            }
        })

        panel.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>CDS Diagram</title>
                <style>
                    body { margin: 0; padding: 0; overflow: hidden; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
                    #controls { position: fixed; top: 10px; right: 10px; z-index: 1000; display: flex; gap: 5px; }
                    button { 
                        background: var(--vscode-button-background); 
                        color: var(--vscode-button-foreground); 
                        border: none; 
                        padding: 5px 10px; 
                        cursor: pointer; 
                        font-family: var(--vscode-font-family);
                    }
                    button:hover { background: var(--vscode-button-hoverBackground); }
                    #viewport { width: 100vw; height: 100vh; overflow: hidden; cursor: grab; }
                    #content { transform-origin: 0 0; width: fit-content; }
                </style>
                <script type="module">
                    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
                    
                    // Get VS Code theme colors
                    const style = getComputedStyle(document.body);
                    const isDark = document.body.classList.contains('vscode-dark') || style.getPropertyValue('--vscode-editor-background').includes('#1'); // heuristic
                    
                    const config = {
                        startOnLoad: true,
                        theme: 'base',
                        themeVariables: {
                            darkMode: true,
                            background: style.getPropertyValue('--vscode-editor-background'),
                            primaryColor: style.getPropertyValue('--vscode-button-background'),
                            primaryTextColor: style.getPropertyValue('--vscode-button-foreground'),
                            secondaryColor: style.getPropertyValue('--vscode-editor-selectionBackground'),
                            tertiaryColor: style.getPropertyValue('--vscode-editor-inactiveSelectionBackground'),
                            primaryBorderColor: style.getPropertyValue('--vscode-editor-foreground'),
                            lineColor: style.getPropertyValue('--vscode-editor-foreground'),
                            textColor: style.getPropertyValue('--vscode-editor-foreground'),
                            fontSize: '20px'
                        },
                        flowchart: {
                            curve: 'basis',
                            htmlLabels: true,
                            useMaxWidth: false
                        },
                        securityLevel: 'loose'
                    };
                    
                    mermaid.initialize(config);
                </script>
            </head>
            <body>
                <div id="controls">
                    <button id="zoomIn">+</button>
                    <button id="zoomOut">-</button>
                    <button id="reset">Reset</button>
                </div>
                <div id="viewport">
                    <div id="content">
                        <pre class="mermaid">
                            ${mermaid}
                        </pre>
                    </div>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    const nodeMapping = ${JSON.stringify(nodeMapping)};
                    
                    window.callNodeClick = (nodeId) => {
                        const realName = nodeMapping[nodeId];
                        if (realName) {
                            vscode.postMessage({ type: 'open', name: realName });
                        }
                    }

                    const viewport = document.getElementById('viewport');
                    const content = document.getElementById('content');
                    let scale = 1;
                    let panning = false;
                    let pointX = 0;
                    let pointY = 0;
                    let startX = 0;
                    let startY = 0;

                    function setTransform() {
                        content.style.transform = \`translate(\${pointX}px, \${pointY}px) scale(\${scale})\`;
                    }

                    document.getElementById('zoomIn').onclick = () => {
                        scale *= 1.2;
                        setTransform();
                    };
                    
                    document.getElementById('zoomOut').onclick = () => {
                        scale /= 1.2;
                        setTransform();
                    };
                    
                    document.getElementById('reset').onclick = () => {
                        scale = 1;
                        pointX = 0;
                        pointY = 0;
                        setTransform();
                    };

                    viewport.onmousedown = function (e) {
                        e.preventDefault();
                        startX = e.clientX - pointX;
                        startY = e.clientY - pointY;
                        panning = true;
                        viewport.style.cursor = 'grabbing';
                    }

                    viewport.onmouseup = function (e) {
                        panning = false;
                        viewport.style.cursor = 'grab';
                    }

                    viewport.onmousemove = function (e) {
                        e.preventDefault();
                        if (!panning) {
                            return;
                        }
                        pointX = (e.clientX - startX);
                        pointY = (e.clientY - startY);
                        setTransform();
                    }

                    viewport.onwheel = function (e) {
                        e.preventDefault();
                        var xs = (e.clientX - pointX) / scale,
                            ys = (e.clientY - pointY) / scale,
                            delta = (e.wheelDelta ? e.wheelDelta : -e.deltaY);
                        (delta > 0) ? (scale *= 1.2) : (scale /= 1.2);
                        pointX = e.clientX - xs * scale;
                        pointY = e.clientY - ys * scale;

                        setTransform();
                    }
                </script>
            </body>
            </html>
        `
    }
}
