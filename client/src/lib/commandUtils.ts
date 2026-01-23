import { window, ProgressLocation, Uri } from "vscode"
import { caughtToString } from "./functions"

/**
 * Type for command handlers that may throw errors
 */
type CommandHandler<T extends any[], R> = (...args: T) => Promise<R>

/**
 * Wraps a command handler with standardized error handling
 * Shows error messages in VS Code notification
 */
export function withErrorHandling<T extends any[], R>(
    handler: CommandHandler<T, R>,
    errorPrefix?: string
): CommandHandler<T, R | undefined> {
    return async (...args: T) => {
        try {
            return await handler(...args)
        } catch (e) {
            const message = errorPrefix
                ? `${errorPrefix}: ${caughtToString(e)}`
                : caughtToString(e)
            window.showErrorMessage(message)
            return undefined
        }
    }
}

/**
 * Wraps a command handler with progress notification
 */
export function withProgress<T extends any[], R>(
    title: string,
    handler: CommandHandler<T, R>,
    location: ProgressLocation = ProgressLocation.Window
): CommandHandler<T, R> {
    return async (...args: T) =>
        window.withProgress({ location, title }, () => handler(...args))
}

/**
 * Combines error handling and progress notification
 */
export function withProgressAndErrorHandling<T extends any[], R>(
    title: string,
    handler: CommandHandler<T, R>,
    errorPrefix?: string,
    location: ProgressLocation = ProgressLocation.Window
): CommandHandler<T, R | undefined> {
    return withErrorHandling(withProgress(title, handler, location), errorPrefix)
}

/**
 * Gets current URI from active editor or tab
 */
export function getCurrentUri(scheme?: string): Uri | undefined {
    const editor = window.activeTextEditor
    if (editor) {
        const uri = editor.document.uri
        if (!scheme || uri.scheme === scheme) return uri
    }

    const tab = window.tabGroups.activeTabGroup.activeTab
    if (tab) {
        const input = tab.input as { uri?: Uri }
        if (input?.uri && (!scheme || input.uri.scheme === scheme)) {
            return input.uri
        }
    }
    return undefined
}

/**
 * Validates that a URI exists and matches expected scheme
 */
export function requireUri(
    uri: Uri | undefined,
    scheme?: string,
    errorMessage = "No file selected"
): Uri {
    if (!uri) throw new Error(errorMessage)
    if (scheme && uri.scheme !== scheme) {
        throw new Error(`Expected ${scheme} URI, got ${uri.scheme}`)
    }
    return uri
}
