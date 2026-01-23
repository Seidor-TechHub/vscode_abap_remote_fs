import * as http from "http"
import * as https from "https"
import { URL } from "url"
import { log } from "./lib"
import { readFileSync, existsSync } from "fs"
import { workspace } from "vscode"

interface ProxyServer {
    server: http.Server
    port: number
    targetUrl: string
}

// Create HTTPS agent with keep-alive for better connection reuse
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 120000  // Default timeout, will be overridden per request
})

const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 120000  // Default timeout, will be overridden per request
})

let activeProxy: ProxyServer | undefined

/**
 * Get the WebGUI proxy timeout setting in milliseconds
 * Returns 0 for no timeout, otherwise converts seconds to milliseconds
 */
function getWebGuiProxyTimeout(): number {
    const config = workspace.getConfiguration("abapfs")
    const timeoutSeconds = config.get<number>("webguiProxyTimeout", 120)
    return timeoutSeconds === 0 ? 0 : timeoutSeconds * 1000
}

/**
 * Create a custom agent with the current timeout setting
 */
function createCustomAgent(isHttps: boolean, rejectUnauthorized: boolean = true, ca?: Buffer): https.Agent | http.Agent {
    const timeout = getWebGuiProxyTimeout()
    if (isHttps) {
        return new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 30000,
            maxSockets: 50,
            maxFreeSockets: 10,
            timeout: timeout,
            rejectUnauthorized: rejectUnauthorized,
            ...(ca && { ca })
        })
    } else {
        return new http.Agent({
            keepAlive: true,
            keepAliveMsecs: 30000,
            maxSockets: 50,
            maxFreeSockets: 10,
            timeout: timeout
        })
    }
}

export function startWebGuiProxy(targetUrl: string, acceptInsecureCerts: boolean = true, caFile?: string, extraHeaders?: { [k: string]: string }): Promise<number> {
    return new Promise((resolve, reject) => {
        // If proxy is already running for this target, reuse it
        if (activeProxy && activeProxy.targetUrl === targetUrl) {
            log(`Reusing existing proxy on port ${activeProxy.port} for ${targetUrl}`)
            resolve(activeProxy.port)
            return
        }

        // Stop existing proxy if running
        if (activeProxy) {
            activeProxy.server.close()
            activeProxy = undefined
        }

        const server = http.createServer((req, res) => {
            if (req.url && req.url.includes("/sap/bc/apc/")) {
                res.writeHead(404)
                res.end()
                return
            }
            const targetUrlObj = new URL(targetUrl)
            const targetHost = targetUrlObj.hostname
            const targetPort = targetUrlObj.port || (targetUrlObj.protocol === "https:" ? "443" : "80")
            const isHttps = targetUrlObj.protocol === "https:"

            // Build the target URL with the incoming request path and query
            const fullTargetUrl = `${targetUrl}${req.url}`
            const targetReqUrl = new URL(fullTargetUrl)

            const headers = Object.assign({}, req.headers)
            // Ensure host header points to target host
            headers.host = targetHost
            // Ensure origin header points to target origin
            if (headers.origin) {
                headers.origin = targetUrlObj.origin
            }
            // Merge in any extra headers (e.g., authentication headers)
            if (extraHeaders) {
                Object.keys(extraHeaders).forEach(k => {
                    headers[k.toLowerCase()] = extraHeaders[k]
                })
            }

            const options: https.RequestOptions = {
                hostname: targetHost,
                port: parseInt(targetPort),
                path: targetReqUrl.pathname + targetReqUrl.search,
                method: req.method,
                headers,
                timeout: getWebGuiProxyTimeout(),  // Configurable timeout from settings
                agent: isHttps ? httpsAgent : httpAgent
            }

            // Handle custom CA file if provided
            if (caFile && existsSync(caFile)) {
                try {
                    const ca = readFileSync(caFile)
                    // @ts-ignore create a custom agent with CA for this request
                    options.agent = createCustomAgent(true, true, ca)
                    log(`WebGUI proxy: using custom CA ${caFile}`)
                } catch (e) {
                    log(`WebGUI proxy: failed to read CA file ${caFile}: ${String(e)}`)
                }
            } else if (isHttps) {
                // No CA file: allow insecure connections if requested
                // @ts-ignore
                options.rejectUnauthorized = !acceptInsecureCerts ? true : false
                if (acceptInsecureCerts) {
                    // Create insecure agent
                    // @ts-ignore
                    options.agent = createCustomAgent(true, false)
                }
            }

            log(`WebGUI proxy request: ${req.method} ${req.url} -> ${isHttps ? 'https' : 'http'}://${targetHost}:${targetPort}${options.path}`)
            if (extraHeaders) log(`WebGUI proxy: injecting extra headers: ${Object.keys(extraHeaders).join(',')}`)

            const protocol = isHttps ? https : http
            const proxyReq = protocol.request(options, (proxyRes) => {
                log(`WebGUI proxy response: ${proxyRes.statusCode} for ${req.url}`)
                if (proxyRes.headers) {
                    const loc = proxyRes.headers['location'] || proxyRes.headers['Location']
                    const setCookie = proxyRes.headers['set-cookie'] || proxyRes.headers['Set-Cookie']
                    if (loc) log(`WebGUI proxy response header Location: ${loc}`)
                    if (setCookie) log(`WebGUI proxy response header Set-Cookie: ${JSON.stringify(setCookie)}`)
                }
                // Allow all CORS
                res.setHeader("Access-Control-Allow-Origin", "*")
                res.setHeader("Access-Control-Allow-Methods", "*")
                res.setHeader("Access-Control-Allow-Headers", "*")
                res.setHeader("Access-Control-Allow-Credentials", "true")

                // Copy response headers, but modify some for iframe embedding
                Object.keys(proxyRes.headers).forEach(key => {
                    const lowerKey = key.toLowerCase()
                    // Skip headers that prevent iframe embedding
                    if (lowerKey === "x-frame-options" ||
                        lowerKey === "content-security-policy" ||
                        lowerKey === "content-security-policy-report-only") {
                        return
                    }
                    const value = proxyRes.headers[key]
                    if (value) {
                        res.setHeader(key, value)
                    }
                })

                res.writeHead(proxyRes.statusCode || 200)
                proxyRes.pipe(res, { end: true })
            })

            const timeoutMs = getWebGuiProxyTimeout()
            
            // Only set up timeout handler if timeout is enabled (not 0)
            if (timeoutMs > 0) {
                proxyReq.on("timeout", () => {
                    log(`WebGUI proxy timeout for ${req.url}`)
                    proxyReq.destroy()
                    if (!res.headersSent) {
                        res.writeHead(504)
                        res.end("Gateway timeout - request took too long")
                    }
                })
            }

            proxyReq.on("error", (err) => {
                log(`WebGUI proxy error: ${err.message}`)
                if (!res.headersSent) {
                    res.writeHead(502)
                    res.end(`Proxy error: ${err.message}`)
                }
            })

            req.on("error", (err) => {
                log(`WebGUI proxy client request error: ${err.message}`)
                proxyReq.destroy()
            })

            req.pipe(proxyReq, { end: true })
        })

        // Try to find an available port starting from 33000
        let port = 33000
        const tryPort = () => {
            server.listen(port, "127.0.0.1", () => {
                activeProxy = {
                    server,
                    port,
                    targetUrl
                }
                log(`WebGUI proxy started on port ${port} for ${targetUrl}`)
                resolve(port)
            })

            server.on("error", (err: NodeJS.ErrnoException) => {
                if (err.code === "EADDRINUSE") {
                    port++
                    if (port > 34000) {
                        reject(new Error("Could not find available port for proxy"))
                        return
                    }
                    server.close()
                    setImmediate(tryPort)
                } else {
                    reject(err)
                }
            })
        }

        tryPort()
    })
}

export function stopWebGuiProxy() {
    if (activeProxy) {
        activeProxy.server.close()
        log(`Stopped WebGUI proxy on port ${activeProxy.port}`)
        activeProxy = undefined
    }
}
