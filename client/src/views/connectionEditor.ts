import {
  window,
  workspace,
  WebviewPanel,
  ViewColumn,
  Uri,
  ConfigurationTarget
} from "vscode"
import { RemoteConfig } from "../config"

interface ConnectionEditorMessage {
  command: string
  connection?: RemoteConfig
  originalName?: string
  target?: ConfigurationTarget
}

export class ConnectionEditor {
  private static currentPanel: WebviewPanel | undefined

  public static show(
    connection: RemoteConfig,
    target: ConfigurationTarget,
    onSave: () => void
  ) {
    const column = ViewColumn.Active

    // If we already have a panel, show it
    if (ConnectionEditor.currentPanel) {
      ConnectionEditor.currentPanel.reveal(column)
      ConnectionEditor.currentPanel.webview.postMessage({
        command: "loadConnection",
        connection,
        target,
        originalName: connection.name
      })
      return
    }

    // Create new panel
    const panel = window.createWebviewPanel(
      "connectionEditor",
      `Edit Connection: ${connection.name}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    )

    ConnectionEditor.currentPanel = panel

    // Set the webview's initial html content
    panel.webview.html = ConnectionEditor.getWebviewContent(connection, target)

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
      async (message: ConnectionEditorMessage) => {
        switch (message.command) {
          case "save":
            if (message.connection && message.originalName !== undefined && message.target !== undefined) {
              await ConnectionEditor.saveConnection(
                message.connection,
                message.originalName,
                message.target
              )
              onSave()
              panel.dispose()
            }
            break
          case "cancel":
            panel.dispose()
            break
        }
      }
    )

    // Reset when the current panel is closed
    panel.onDidDispose(() => {
      ConnectionEditor.currentPanel = undefined
    })

    // Send initial data
    panel.webview.postMessage({
      command: "loadConnection",
      connection,
      target,
      originalName: connection.name
    })
  }

  private static async saveConnection(
    connection: RemoteConfig,
    originalName: string,
    target: ConfigurationTarget
  ) {
    const config = workspace.getConfiguration("abapfs")
    const targetRemotes =
      target === ConfigurationTarget.Global
        ? ((config.inspect("remote")?.globalValue as Record<string, RemoteConfig>) || {})
        : ((config.inspect("remote")?.workspaceValue as Record<string, RemoteConfig>) || {})

    const updatedRemotes = { ...targetRemotes }

    // If name changed, delete old entry
    if (connection.name !== originalName) {
      delete updatedRemotes[originalName]
    }

    updatedRemotes[connection.name] = connection

    await config.update("remote", updatedRemotes, target)

    window.showInformationMessage(`Connection "${connection.name}" saved successfully`)
  }

  private static getWebviewContent(connection: RemoteConfig, target: ConfigurationTarget): string {
    const targetName = target === ConfigurationTarget.Global ? "User" : "Workspace"
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Edit Connection</title>
    <style>
        body {
            padding: 20px;
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
        .form-container {
            max-width: 800px;
            margin: 0 auto;
        }
        .form-header {
            margin-bottom: 30px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .form-header h1 {
            margin: 0 0 10px 0;
            font-size: 24px;
            font-weight: 600;
        }
        .form-header .subtitle {
            color: var(--vscode-descriptionForeground);
            font-size: 13px;
        }
        .form-section {
            margin-bottom: 30px;
        }
        .section-title {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 15px;
            color: var(--vscode-foreground);
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 6px;
            font-weight: 500;
            color: var(--vscode-foreground);
        }
        .label-description {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            font-weight: normal;
            margin-left: 4px;
        }
        input[type="text"],
        input[type="password"],
        select {
            width: 100%;
            padding: 8px 10px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            box-sizing: border-box;
        }
        input:focus,
        select:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }
        input[type="checkbox"] {
            margin-right: 8px;
            vertical-align: middle;
        }
        .checkbox-label {
            display: inline;
            margin-bottom: 0;
            vertical-align: middle;
        }
        .error {
            color: var(--vscode-errorForeground);
            font-size: 12px;
            margin-top: 4px;
            display: none;
        }
        .error.show {
            display: block;
        }
        .button-group {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 10px;
        }
        button {
            padding: 8px 16px;
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            font-weight: 500;
        }
        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .collapsible {
            margin-top: 20px;
        }
        .collapsible-header {
            cursor: pointer;
            padding: 10px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 2px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .collapsible-header:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .collapsible-content {
            display: none;
            padding: 20px;
            border: 1px solid var(--vscode-panel-border);
            border-top: none;
            border-radius: 0 0 2px 2px;
        }
        .collapsible-content.show {
            display: block;
        }
        .arrow {
            transition: transform 0.2s;
        }
        .arrow.open {
            transform: rotate(90deg);
        }
        .help-text {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
    </style>
</head>
<body>
    <div class="form-container">
        <div class="form-header">
            <h1>Edit Connection</h1>
            <div class="subtitle">Scope: ${targetName} Settings</div>
        </div>

        <form id="connectionForm">
            <div class="form-section">
                <div class="section-title">Basic Information</div>
                
                <div class="form-group">
                    <label for="name">Connection Name <span class="label-description">*</span></label>
                    <input type="text" id="name" name="name" required value="${this.escapeHtml(connection.name)}">
                    <div class="error" id="nameError"></div>
                    <div class="help-text">Unique identifier for this connection (letters, numbers, -, _ only)</div>
                </div>

                <div class="form-group">
                    <label for="url">Server URL <span class="label-description">*</span></label>
                    <input type="text" id="url" name="url" required value="${this.escapeHtml(connection.url)}">
                    <div class="error" id="urlError"></div>
                    <div class="help-text">Format: http(s)://hostname[:port] (e.g., https://myserver.com:44311)</div>
                </div>

                <div class="form-group">
                    <label for="username">Username <span class="label-description">*</span></label>
                    <input type="text" id="username" name="username" required value="${this.escapeHtml(connection.username)}">
                </div>

                <div class="form-group">
                    <label for="client">Client <span class="label-description">*</span></label>
                    <input type="text" id="client" name="client" required maxlength="3" pattern="[0-9]{3}" value="${this.escapeHtml(connection.client)}">
                    <div class="error" id="clientError"></div>
                    <div class="help-text">3-digit client number (001-999)</div>
                </div>

                <div class="form-group">
                    <label for="language">Language <span class="label-description">*</span></label>
                    <input type="text" id="language" name="language" required maxlength="2" pattern="[a-zA-Z]{2}" value="${this.escapeHtml(connection.language)}">
                    <div class="error" id="languageError"></div>
                    <div class="help-text">2-letter language code (e.g., EN, DE, ES)</div>
                </div>
            </div>

            <div class="form-section">
                <div class="section-title">SSL Configuration</div>
                
                <div class="form-group">
                    <input type="checkbox" id="allowSelfSigned" name="allowSelfSigned" ${connection.allowSelfSigned ? "checked" : ""}>
                    <label for="allowSelfSigned" class="checkbox-label">Allow self-signed certificates</label>
                    <div class="help-text">⚠️ Not recommended for production environments</div>
                </div>

                <div class="form-group">
                    <label for="customCA">Custom CA Certificate <span class="label-description">(optional)</span></label>
                    <input type="text" id="customCA" name="customCA" value="${this.escapeHtml(connection.customCA || "")}">
                    <div class="help-text">Path to certificate file or PEM content</div>
                </div>
            </div>

            <div class="form-section">
                <div class="section-title">Preferences</div>
                
                <div class="form-group">
                    <label for="diffFormatter">Diff Formatter</label>
                    <select id="diffFormatter" name="diffFormatter">
                        <option value="ADT formatter" ${connection.diff_formatter === "ADT formatter" ? "selected" : ""}>ADT Formatter</option>
                        <option value="AbapLint" ${connection.diff_formatter === "AbapLint" ? "selected" : ""}>AbapLint</option>
                        <option value="Simple" ${connection.diff_formatter === "Simple" ? "selected" : ""}>Simple</option>
                    </select>
                </div>
            </div>

            <div class="collapsible">
                <div class="collapsible-header" onclick="toggleCollapsible('oauthSection')">
                    <span>OAuth Configuration (Optional)</span>
                    <span class="arrow" id="oauthArrow">▶</span>
                </div>
                <div class="collapsible-content" id="oauthSection">
                    <div class="form-group">
                        <label for="oauthClientId">Client ID</label>
                        <input type="text" id="oauthClientId" name="oauthClientId" value="${this.escapeHtml(connection.oauth?.clientId || "")}">
                    </div>

                    <div class="form-group">
                        <label for="oauthClientSecret">Client Secret</label>
                        <input type="password" id="oauthClientSecret" name="oauthClientSecret" value="${this.escapeHtml(connection.oauth?.clientSecret || "")}">
                    </div>

                    <div class="form-group">
                        <label for="oauthLoginUrl">Login URL</label>
                        <input type="text" id="oauthLoginUrl" name="oauthLoginUrl" value="${this.escapeHtml(connection.oauth?.loginUrl || "")}">
                    </div>

                    <div class="form-group">
                        <input type="checkbox" id="oauthSaveCredentials" name="oauthSaveCredentials" ${connection.oauth?.saveCredentials ? "checked" : ""}>
                        <label for="oauthSaveCredentials" class="checkbox-label">Save OAuth credentials</label>
                    </div>
                </div>
            </div>

            <div class="button-group">
                <button type="submit" class="btn-primary">Save Connection</button>
                <button type="button" class="btn-secondary" onclick="cancel()">Cancel</button>
            </div>
        </form>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let originalName = '';
        let target = ${target};

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'loadConnection') {
                originalName = message.originalName;
                target = message.target;
            }
        });

        function toggleCollapsible(id) {
            const content = document.getElementById(id);
            const arrow = document.getElementById(id.replace('Section', 'Arrow'));
            content.classList.toggle('show');
            arrow.classList.toggle('open');
        }

        function validateName(name) {
            if (!name || name.length < 3) {
                return 'Name must be at least 3 characters';
            }
            if (!/^[\\w\\d-_]+$/i.test(name)) {
                return 'Only letters, numbers, - and _ are allowed';
            }
            return null;
        }

        function validateUrl(url) {
            if (!url) {
                return 'URL is required';
            }
            if (!/^http(s)?:\\/\\/[\\w\\.-]+(:\\d+)?$/i.test(url)) {
                return 'Format: http(s)://domain[:port]';
            }
            return null;
        }

        function validateClient(client) {
            if (!client) {
                return 'Client is required';
            }
            if (!/^\\d{3}$/.test(client)) {
                return 'Client must be a 3 digit number';
            }
            if (client === '000') {
                return 'Client cannot be 000';
            }
            return null;
        }

        function validateLanguage(language) {
            if (!language) {
                return 'Language is required';
            }
            if (!/^[a-zA-Z]{2}$/.test(language)) {
                return 'Language must be 2 letters';
            }
            return null;
        }

        function showError(fieldId, message) {
            const errorElement = document.getElementById(fieldId + 'Error');
            if (errorElement) {
                errorElement.textContent = message;
                errorElement.classList.add('show');
            }
        }

        function clearError(fieldId) {
            const errorElement = document.getElementById(fieldId + 'Error');
            if (errorElement) {
                errorElement.textContent = '';
                errorElement.classList.remove('show');
            }
        }

        // Real-time validation
        document.getElementById('name').addEventListener('input', (e) => {
            const error = validateName(e.target.value);
            if (error) {
                showError('name', error);
            } else {
                clearError('name');
            }
        });

        document.getElementById('url').addEventListener('input', (e) => {
            const error = validateUrl(e.target.value);
            if (error) {
                showError('url', error);
            } else {
                clearError('url');
            }
        });

        document.getElementById('client').addEventListener('input', (e) => {
            const error = validateClient(e.target.value);
            if (error) {
                showError('client', error);
            } else {
                clearError('client');
            }
        });

        document.getElementById('language').addEventListener('input', (e) => {
            const error = validateLanguage(e.target.value);
            if (error) {
                showError('language', error);
            } else {
                clearError('language');
            }
        });

        document.getElementById('connectionForm').addEventListener('submit', (e) => {
            e.preventDefault();

            // Validate all fields
            const name = document.getElementById('name').value;
            const url = document.getElementById('url').value;
            const client = document.getElementById('client').value;
            const language = document.getElementById('language').value;

            let hasErrors = false;

            const nameError = validateName(name);
            if (nameError) {
                showError('name', nameError);
                hasErrors = true;
            }

            const urlError = validateUrl(url);
            if (urlError) {
                showError('url', urlError);
                hasErrors = true;
            }

            const clientError = validateClient(client);
            if (clientError) {
                showError('client', clientError);
                hasErrors = true;
            }

            const languageError = validateLanguage(language);
            if (languageError) {
                showError('language', languageError);
                hasErrors = true;
            }

            if (hasErrors) {
                return;
            }

            // Build connection object
            const connection = {
                name: name,
                url: url,
                username: document.getElementById('username').value,
                password: '', // Keep existing password
                client: client,
                language: language.toLowerCase(),
                allowSelfSigned: document.getElementById('allowSelfSigned').checked,
                customCA: document.getElementById('customCA').value || undefined,
                diff_formatter: document.getElementById('diffFormatter').value
            };

            // Add OAuth if any field is filled
            const oauthClientId = document.getElementById('oauthClientId').value;
            const oauthClientSecret = document.getElementById('oauthClientSecret').value;
            const oauthLoginUrl = document.getElementById('oauthLoginUrl').value;

            if (oauthClientId || oauthClientSecret || oauthLoginUrl) {
                connection.oauth = {
                    clientId: oauthClientId,
                    clientSecret: oauthClientSecret,
                    loginUrl: oauthLoginUrl,
                    saveCredentials: document.getElementById('oauthSaveCredentials').checked
                };
            }

            vscode.postMessage({
                command: 'save',
                connection: connection,
                originalName: originalName,
                target: target
            });
        });

        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }
    </script>
</body>
</html>`;
  }

  private static escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }
    return text.replace(/[&<>"']/g, (m: string) => map[m] as string)
  }
}
