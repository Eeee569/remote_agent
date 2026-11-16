// Development rig for the iPhone app's web layer.
//
// Serves the built bundle (ios/RemoteAgent/web/index.html) and connects it to
// the *same* Swift bridge the app embeds, running as a Linux process:
//
//   browser  --POST /rpc-->  this server  --stdin-->   ra-bridge-stdio (Swift)
//   browser  <--SSE /events- this server  <--stdout--  ra-bridge-stdio
//
// So the UI, the JSON protocol, and the SSH core are all exercised for real
// without a device; only the thin WKWebView wrapper is left out.
//
//   npm run build:ios-web
//   node ios/dev/server.mjs            # then open http://localhost:5199
//
// RA_BRIDGE_CMD overrides how the bridge is started (default: `swift run` in a
// swift:6.1 container, for machines without a Swift toolchain).
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const core = resolve(here, '../RemoteAgentCore')
const page = resolve(here, '../RemoteAgent/web/index.html')
const port = Number(process.env.PORT || 5199)
const storePath = process.env.RA_STORE || '/tmp/ra-bridge-store.json'

const defaultCmd =
  `docker run --rm -i --network host -v ${core}:/pkg -w /pkg swift:6.1-jammy ` +
  `swift run ra-bridge-stdio ${storePath}`
const bridge = spawn(process.env.RA_BRIDGE_CMD || defaultCmd, {
  shell: true,
  stdio: ['pipe', 'pipe', 'inherit']
})
bridge.on('exit', (code) => {
  console.error(`bridge exited (${code})`)
  process.exit(1)
})

const clients = new Set()
createInterface({ input: bridge.stdout }).on('line', (line) => {
  if (!line.startsWith('{')) return // build chatter from `swift run`
  for (const res of clients) res.write(`data: ${line}\n\n`)
})

createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/rpc') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      bridge.stdin.write(body.replace(/\n/g, ' ') + '\n')
      res.writeHead(204).end()
    })
    return
  }
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    res.write(':ok\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(readFileSync(page))
    return
  }
  res.writeHead(404).end()
}).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}`))

const stop = () => {
  bridge.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
