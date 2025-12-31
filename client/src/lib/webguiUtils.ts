import { Uri } from "vscode"
import { getClient } from "../adt/conections"
import { RemoteConfig } from "../config"
import { startWebGuiProxy } from "../webguiProxy"

/**
 * Shared utility for setting up WebGUI proxy with authentication
 * Eliminates duplicate code between webGuiEditor.ts and commands.ts
 */
export interface WebGuiProxyResult {
    proxyUrl?: string
    directUrl: string
}

/**
 * Sets up a WebGUI proxy if needed for HTTPS with self-signed certificates
 * @param config Remote configuration
 * @param url The WebGUI URL
 * @param connId Connection ID for authentication
 * @returns Object with proxyUrl (if proxy was started) and directUrl
 */
export async function setupWebGuiProxy(
    config: RemoteConfig,
    url: Uri,
    connId: string
): Promise<WebGuiProxyResult> {
    const directUrl = url.toString()

    // Only use proxy for HTTPS with self-signed certificates
    if (url.scheme !== "https" || !config.allowSelfSigned) {
        return { directUrl }
    }

    try {
        const targetBaseUrl = `${url.scheme}://${url.authority}`

        // Try to get a reentrance ticket to authenticate the WebGUI
        const extraHeaders = await getReentranceHeaders(connId, config.client, directUrl)

        const port = await startWebGuiProxy(targetBaseUrl, true, config.customCA, extraHeaders)
        const proxyUrl = `http://127.0.0.1:${port}${url.path}${url.query ? '?' + url.query : ''}`

        return { proxyUrl, directUrl }
    } catch (e) {
        console.error("Failed to start WebGUI proxy:", e)
        // Fall back to direct URL
        return { directUrl }
    }
}

/**
 * Gets reentrance ticket headers for WebGUI authentication
 */
async function getReentranceHeaders(
    connId: string,
    client: string | undefined,
    redirectUrl: string
): Promise<Record<string, string> | undefined> {
    try {
        const adtClient = getClient(connId)
        if (adtClient && (adtClient as any).reentranceTicket) {
            const ticket = await (adtClient as any).reentranceTicket()
            if (ticket) {
                return {
                    "sap-mysapsso": `${client || ""}${ticket}`,
                    "sap-mysapred": redirectUrl
                }
            }
        }
    } catch {
        // Ignore ticket errors, fallback to proxy without headers
    }
    return undefined
}

/**
 * Builds the final URL to use for WebGUI display
 * Uses proxy URL if available, otherwise direct URL
 */
export function getDisplayUrl(result: WebGuiProxyResult): string {
    return result.proxyUrl ?? result.directUrl
}
