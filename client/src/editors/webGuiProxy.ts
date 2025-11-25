import * as http from 'http'
import * as https from 'https'
import { RemoteConfig } from '../config'
import { Uri } from 'vscode'

export class WebGuiProxy {
    private server: http.Server
    private port: number = 0;

    constructor(private config: RemoteConfig) {
        this.server = http.createServer((req, res) => this.handleRequest(req, res))
    }

    public async start(): Promise<string> {
        return new Promise((resolve, reject) => {
            this.server.listen(0, '127.0.0.1', () => {
                const addr = this.server.address()
                if (addr && typeof addr === 'object') {
                    this.port = addr.port
                    resolve(`http://127.0.0.1:${this.port}`)
                } else {
                    reject(new Error('Failed to get server port'))
                }
            })
        })
    }

    public stop() {
        this.server.close()
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        if (!req.url) return

        const targetUrl = Uri.parse(this.config.url)
        const [hostname, port] = targetUrl.authority.split(':')

        const options: https.RequestOptions = {
            hostname: hostname,
            port: port || (targetUrl.scheme === 'https' ? 443 : 80),
            path: req.url,
            method: req.method,
            headers: req.headers,
            rejectUnauthorized: !this.config.allowSelfSigned,
            ca: this.config.customCA
        }

        // Remove host header to avoid issues with virtual hosts or SNI
        if (options.headers) {
            delete options.headers.host
            // Some servers check origin/referer
            if (options.headers.origin) options.headers.origin = `${targetUrl.scheme}://${targetUrl.authority}`
            if (options.headers.referer) options.headers.referer = `${targetUrl.scheme}://${targetUrl.authority}${req.url}`
        }

        const proxyReq = (targetUrl.scheme === 'https' ? https : http).request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 500, proxyRes.headers)
            proxyRes.pipe(res)
        })

        proxyReq.on('error', (err) => {
            console.error('Proxy error:', err)
            res.statusCode = 500
            res.end('Proxy error: ' + err.message)
        })

        req.pipe(proxyReq)
    }
}
