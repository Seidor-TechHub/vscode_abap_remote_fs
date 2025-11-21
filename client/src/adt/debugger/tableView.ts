import { ExtensionContext, ViewColumn, WebviewPanel, window, Uri } from "vscode"
import { caughtToString } from "../../lib"

export class TableView {
    public static readonly viewType = 'abapfs.tableView'
    private panel: WebviewPanel

    constructor(context: ExtensionContext, private title: string, private data: any[], private total?: number) {
        this.panel = window.createWebviewPanel(
            TableView.viewType,
            `Table: ${title}`,
            ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        )

        this.update()
        this.panel.onDidDispose(() => this.dispose(), null, context.subscriptions)
    }

    public dispose() {
        this.panel.dispose()
    }

    private update() {
        this.panel.webview.html = this.getHtmlForWebview(this.data)
    }

    private getHtmlForWebview(data: any[]) {
        if (!data || data.length === 0) {
            return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <style>
                    body { font-family: var(--vscode-editor-font-family); color: var(--vscode-editor-foreground); padding: 20px; }
                </style>
            </head>
            <body>
                <h3>No data to display</h3>
            </body>
            </html>`
        }

        // Assume data is an array of objects
        const headers = Object.keys(data[0])

        const headerRow = headers.map(h => `<th>${h}</th>`).join('')
        const rows = data.map(row => {
            const cells = headers.map(h => {
                let val = row[h]
                if (typeof val === 'object' && val !== null) val = JSON.stringify(val)
                return `<td title="${val}">${val}</td>`
            }).join('')
            return `<tr>${cells}</tr>`
        }).join('')

        const countMsg = this.total && this.total > data.length
            ? `(Showing ${data.length} of ${this.total} rows)`
            : `(${data.length} rows)`

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${this.title}</title>
            <style>
                :root {
                    --font-family: var(--vscode-editor-font-family);
                    --font-size: var(--vscode-editor-font-size);
                    --foreground: var(--vscode-editor-foreground);
                    --background: var(--vscode-editor-background);
                    --header-bg: var(--vscode-editor-group-header-tabsBackground);
                    --border: var(--vscode-panel-border);
                    --row-hover: var(--vscode-list-hoverBackground);
                    --row-active: var(--vscode-list-activeSelectionBackground);
                    --row-active-fg: var(--vscode-list-activeSelectionForeground);
                }
                body {
                    font-family: var(--font-family);
                    font-size: var(--font-size);
                    color: var(--foreground);
                    background-color: var(--background);
                    margin: 0;
                    padding: 0;
                    height: 100vh;
                    overflow: hidden;
                }
                .table-container {
                    height: 100%;
                    overflow: auto;
                }
                .header-info {
                    padding: 8px 16px;
                    font-weight: bold;
                    border-bottom: 1px solid var(--border);
                    background-color: var(--background);
                    position: sticky;
                    top: 0;
                    left: 0;
                    z-index: 2;
                }
                table {
                    border-collapse: collapse;
                    width: 100%;
                    font-size: 13px;
                }
                th {
                    position: sticky;
                    top: 35px; /* Height of header-info approx */
                    background-color: var(--vscode-sideBar-background); 
                    color: var(--foreground);
                    border-bottom: 1px solid var(--border);
                    border-right: 1px solid var(--border);
                    padding: 4px 8px;
                    text-align: left;
                    font-weight: 600;
                    z-index: 1;
                }
                td {
                    border-bottom: 1px solid var(--border);
                    border-right: 1px solid var(--border);
                    padding: 4px 8px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 400px;
                }
                tr:hover {
                    background-color: var(--row-hover);
                    cursor: default;
                }
                tr.selected {
                    background-color: var(--row-active);
                    color: var(--row-active-fg);
                }
            </style>
            <script>
                document.addEventListener('DOMContentLoaded', () => {
                    const table = document.querySelector('table');
                    table.addEventListener('click', (e) => {
                        const tr = e.target.closest('tr');
                        if (tr && tr.parentElement.tagName === 'TBODY') {
                            document.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
                            tr.classList.add('selected');
                        }
                    });
                });
            </script>
        </head>
        <body>
            <div class="table-container">
                <div class="header-info">${this.title} ${countMsg}</div>
                <table>
                    <thead>
                        <tr>${headerRow}</tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
            </div>
        </body>
        </html>`
    } public static createOrShow(context: ExtensionContext, title: string, data: any[], total?: number) {
        new TableView(context, title, data, total)
    }
}
