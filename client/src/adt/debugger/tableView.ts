import { ExtensionContext, WebviewView, WebviewViewProvider, window, commands } from "vscode"

export class TableViewProvider implements WebviewViewProvider {
    public static readonly viewType = 'abapfs.views.tableView'
    private _view?: WebviewView
    private _data: any[] = []
    private _title: string = "No Data"
    private _total?: number
    private _start: number = 0
    private _limit: number = 100
    private _controller?: {
        onEdit: (row: number, name: string, value: string) => Promise<boolean>
        onRequestPage: (start: number, limit: number) => Promise<void>
    }

    private static _instance: TableViewProvider

    private constructor() { }

    public static get instance() {
        if (!this._instance) {
            this._instance = new TableViewProvider()
        }
        return this._instance
    }

    public resolveWebviewView(webviewView: WebviewView) {
        this._view = webviewView
        webviewView.webview.options = {
            enableScripts: true
        }
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'edit':
                    if (this._controller) {
                        const success = await this._controller.onEdit(message.row, message.name, message.value)
                    }
                    break
                case 'requestPage':
                    if (this._controller) {
                        await this._controller.onRequestPage(message.start, message.limit)
                    }
                    break
            }
        })
        this.update()
    }

    public show(title: string, data: any[], total: number | undefined, start: number, limit: number, controller?: any) {
        this._title = title
        this._data = data
        this._total = total
        this._start = start
        this._limit = limit
        this._controller = controller

        if (this._view) {
            this._view.show(true)
            this.update()
        } else {
            commands.executeCommand('abapfs.views.tableView.focus')
        }
    }

    private update() {
        if (this._view) {
            this._view.webview.html = this.getHtmlForWebview(this._data)
        }
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

        const headerRow = headers.map(h => `
            <th data-col="${h}">
                <div class="header-content">
                    <div>${h}</div>
                    <input type="text" class="filter-input" placeholder="Filter..." oninput="filterColumn(this, '${h}')">
                </div>
                <div class="resizer"></div>
            </th>`).join('')
        const rows = data.map((row, rowIndex) => {
            const cells = headers.map(h => {
                let val = row[h]
                let displayVal = val
                if (typeof val === 'object' && val !== null) displayVal = JSON.stringify(val)
                // Add data attributes for editing
                return `<td contenteditable="true" data-row="${rowIndex + this._start}" data-col="${h}" title="${displayVal}">${displayVal}</td>`
            }).join('')
            return `<tr>${cells}</tr>`
        }).join('')

        const countMsg = this._total
            ? `(Showing ${this._start + 1}-${this._start + data.length} of ${this._total} rows)`
            : `(${data.length} rows)`

        const pageControls = this._total ? `
            <div class="pagination">
                <label>Limit: <input type="number" id="limitInput" value="${this._limit}" min="1" style="width: 50px;"></label>
                <button onclick="changePage(-1)" ${this._start === 0 ? 'disabled' : ''}>Prev</button>
                <span>${Math.floor(this._start / this._limit) + 1} / ${Math.ceil(this._total / this._limit)}</span>
                <button onclick="changePage(1)" ${this._start + this._limit >= this._total ? 'disabled' : ''}>Next</button>
            </div>
        ` : ''

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${this._title}</title>
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
                    --button-bg: var(--vscode-button-background);
                    --button-fg: var(--vscode-button-foreground);
                    --button-hover: var(--vscode-button-hoverBackground);
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
                    display: flex;
                    flex-direction: column;
                }
                .table-container {
                    flex: 1 1 auto;
                    overflow: auto;
                    position: relative;
                }
                .header-info {
                    padding: 8px 16px;
                    font-weight: bold;
                    border-bottom: 1px solid var(--border);
                    background-color: var(--background);
                    z-index: 2;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex: 0 0 auto;
                }
                .pagination {
                    display: flex;
                    gap: 8px;
                    align-items: center;
                }
                .pagination button {
                    background: var(--button-bg);
                    color: var(--button-fg);
                    border: none;
                    padding: 4px 8px;
                    cursor: pointer;
                }
                .pagination button:hover {
                    background: var(--button-hover);
                }
                .pagination button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                table {
                    border-collapse: collapse;
                    width: 100%;
                    font-size: 13px;
                }
                th {
                    position: sticky;
                    top: 0;
                    background-color: var(--vscode-sideBar-background); 
                    color: var(--foreground);
                    border-bottom: 1px solid var(--border);
                    border-right: 1px solid var(--border);
                    padding: 0;
                    text-align: left;
                    font-weight: 600;
                    z-index: 1;
                }
                .header-content {
                    padding: 4px 8px;
                }
                .resizer {
                    position: absolute;
                    top: 0;
                    right: 0;
                    width: 5px;
                    cursor: col-resize;
                    user-select: none;
                    height: 100vh;
                    z-index: 100;
                }
                .resizer:hover, .resizing {
                    background-color: var(--vscode-focusBorder);
                }
                .filter-input {
                    width: 100%;
                    box-sizing: border-box;
                    margin-top: 4px;
                    padding: 2px 4px;
                    border: 1px solid var(--border);
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    font-family: var(--font-family);
                    font-size: 11px;
                }
                .filter-input:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                }
                td {
                    border-bottom: 1px solid var(--border);
                    border-right: 1px solid var(--border);
                    padding: 4px 8px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 400px;
                    outline: none;
                }
                td:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
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
                const vscode = acquireVsCodeApi();
                const filters = {};
                const currentStart = ${this._start};
                const currentLimit = ${this._limit};

                function filterColumn(input, colName) {
                    filters[colName] = input.value.toUpperCase();
                    applyFilters();
                }

                function applyFilters() {
                    const table = document.querySelector('table');
                    const trs = table.querySelectorAll('tbody tr');
                    const headers = Array.from(table.querySelectorAll('th'));
                    
                    trs.forEach(tr => {
                        let visible = true;
                        for (const [colName, filterValue] of Object.entries(filters)) {
                            if (!filterValue) continue;
                            
                            const colIndex = headers.findIndex(th => th.dataset.col === colName);
                            if (colIndex === -1) continue;

                            const td = tr.cells[colIndex];
                            if (td) {
                                const txtValue = td.textContent || td.innerText;
                                if (txtValue.toUpperCase().indexOf(filterValue) === -1) {
                                    visible = false;
                                    break;
                                }
                            }
                        }
                        tr.style.display = visible ? "" : "none";
                    });
                }

                function changePage(direction) {
                    const limitInput = document.getElementById('limitInput');
                    const limit = parseInt(limitInput.value) || 100;
                    const newStart = currentStart + (direction * limit);
                    if (newStart < 0) return;
                    
                    vscode.postMessage({
                        command: 'requestPage',
                        start: newStart,
                        limit: limit
                    });
                }

                document.addEventListener('DOMContentLoaded', () => {
                    const limitInput = document.getElementById('limitInput');
                    if (limitInput) {
                        limitInput.addEventListener('change', () => {
                            const limit = parseInt(limitInput.value) || 100;
                            vscode.postMessage({
                                command: 'requestPage',
                                start: 0, // Reset to first page on limit change
                                limit: limit
                            });
                        });
                    }

                    const table = document.querySelector('table');
                    
                    // Column Resizing
                    const resizers = document.querySelectorAll('.resizer');
                    let currentResizer;
                    let startX = 0;
                    let startWidth = 0;

                    resizers.forEach(resizer => {
                        resizer.addEventListener('mousedown', function(e) {
                            currentResizer = e.target;
                            const th = currentResizer.parentElement;
                            startX = e.pageX;
                            startWidth = th.offsetWidth;
                            
                            currentResizer.classList.add('resizing');
                            
                            document.addEventListener('mousemove', resize);
                            document.addEventListener('mouseup', stopResize);
                        });
                    });

                    function resize(e) {
                        if (currentResizer) {
                            const th = currentResizer.parentElement;
                            const width = startWidth + (e.pageX - startX);
                            if (width > 50) { // Minimum width
                                th.style.width = width + 'px';
                                th.style.minWidth = width + 'px';
                                th.style.maxWidth = width + 'px';
                            }
                        }
                    }

                    function stopResize() {
                        if (currentResizer) {
                            currentResizer.classList.remove('resizing');
                            currentResizer = null;
                        }
                        document.removeEventListener('mousemove', resize);
                        document.removeEventListener('mouseup', stopResize);
                    }
                    
                    // Row Selection
                    table.addEventListener('click', (e) => {
                        const tr = e.target.closest('tr');
                        if (tr && tr.parentElement.tagName === 'TBODY') {
                            document.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
                            tr.classList.add('selected');
                        }
                    });

                    // Editing
                    table.addEventListener('keydown', (e) => {
                        if (e.target.tagName === 'TD' && e.key === 'Enter') {
                            e.preventDefault();
                            e.target.blur();
                        }
                    });

                    table.addEventListener('focusout', (e) => {
                        if (e.target.tagName === 'TD') {
                            const row = e.target.dataset.row;
                            const col = e.target.dataset.col;
                            const value = e.target.innerText;
                            // Send update
                            vscode.postMessage({
                                command: 'edit',
                                row: parseInt(row),
                                name: col,
                                value: value
                            });
                        }
                    });
                });
            </script>
        </head>
        <body>
            <div class="header-info">
                <span>${this._title} ${countMsg}</span>
                ${pageControls}
            </div>
            <div class="table-container">
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
    }
}
