import Citadel
import Crypto
import Foundation
import NIOCore
import NIOSSH

/// Where the bridge keeps the host list (which includes secrets). The app backs
/// this with the Keychain; the Linux test harness with a file.
public protocol BridgeStore: AnyObject {
    func get(_ key: String) -> String?
    func set(_ key: String, value: String?)
}

/// An error that reaches the web UI as `{code, message}`.
public struct BridgeError: Error {
    public let code: String
    public let message: String

    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

public typealias BridgeHandler = @Sendable ([String: Any]) async throws -> Any?

/// The native half of the app: SSH connections, exec, and PTY channels, spoken
/// to over a JSON message protocol so the same web UI can sit on top of it in a
/// WKWebView (the app) or behind a dev server (Linux).
///
///   request   {"id": 1, "method": "ssh.exec", "params": {...}}
///   response  {"id": 1, "ok": true, "result": ...}
///             {"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}
///   event     {"event": "term.data", "termId": "t1", "data": "<base64>"}
public actor Bridge {
    private enum TermInput {
        case data(ByteBuffer)
        case resize(cols: Int, rows: Int)
    }

    private final class Connection {
        let id: String
        let client: SSHClient
        init(id: String, client: SSHClient) {
            self.id = id
            self.client = client
        }
    }

    private final class Term {
        let id: String
        let connId: String
        let input: AsyncStream<TermInput>.Continuation
        var task: Task<Void, Never>?
        var ready: CheckedContinuation<Void, Error>?
        var pending: [UInt8] = []
        var flushScheduled = false
        var closedByUser = false

        init(id: String, connId: String, input: AsyncStream<TermInput>.Continuation) {
            self.id = id
            self.connId = connId
            self.input = input
        }
    }

    /// Terminal output is coalesced so a busy TUI is one message per tick, not
    /// one per SSH packet.
    private static let flushDelayNs: UInt64 = 10_000_000
    private static let flushThreshold = 64 * 1024
    private static let maxExecOutput = 16 * 1024 * 1024

    private let store: BridgeStore
    private let emitRaw: @Sendable (String) -> Void
    private var extra: [String: BridgeHandler] = [:]
    private var connections: [String: Connection] = [:]
    private var terms: [String: Term] = [:]
    private var counter = 0

    private let inbox: AsyncStream<String>.Continuation

    public init(store: BridgeStore, emit: @escaping @Sendable (String) -> Void) {
        self.store = store
        self.emitRaw = emit
        let (stream, continuation) = AsyncStream<String>.makeStream()
        self.inbox = continuation
        Task { [weak self] in
            // one consumer, so messages are dispatched in the order they were
            // posted — keystrokes must not overtake each other
            for await message in stream {
                guard let self else { return }
                await self.dispatch(message)
            }
        }
    }

    /// Adds a method the core does not know (clipboard, app lifecycle, ...).
    public func register(_ method: String, handler: @escaping BridgeHandler) {
        extra[method] = handler
    }

    /// Entry point for a message from the web UI. Safe to call from any thread.
    public nonisolated func handle(message: String) {
        inbox.yield(message)
    }

    /// Pushes an event to the web UI.
    public nonisolated func emit(event: String, _ fields: [String: Any] = [:]) {
        var payload = fields
        payload["event"] = event
        emitRaw(Bridge.json(payload))
    }

    // MARK: - dispatch

    private func dispatch(_ message: String) {
        guard
            let data = message.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let method = object["method"] as? String
        else { return }
        let id = Bridge.int(object["id"])
        let params = object["params"] as? [String: Any] ?? [:]

        // terminal input stays on this (ordered) path
        switch method {
        case "term.write":
            if let term = terms[params["termId"] as? String ?? ""],
               let b64 = params["data"] as? String,
               let bytes = Data(base64Encoded: b64) {
                term.input.yield(.data(ByteBuffer(bytes: bytes)))
            }
            return
        case "term.resize":
            if let term = terms[params["termId"] as? String ?? ""],
               let cols = Bridge.int(params["cols"]), let rows = Bridge.int(params["rows"]),
               cols > 0, rows > 0 {
                term.input.yield(.resize(cols: cols, rows: rows))
            }
            return
        default:
            break
        }

        Task {
            do {
                let result = try await self.call(method, params)
                self.respond(id, ok: true, body: result ?? NSNull())
            } catch let error as BridgeError {
                self.respond(id, ok: false, body: ["code": error.code, "message": error.message])
            } catch {
                self.respond(id, ok: false, body: ["code": "internal", "message": Bridge.describe(error)])
            }
        }
    }

    private nonisolated func respond(_ id: Int?, ok: Bool, body: Any) {
        guard let id else { return }
        emitRaw(Bridge.json(["id": id, "ok": ok, ok ? "result" : "error": body]))
    }

    private func call(_ method: String, _ p: [String: Any]) async throws -> Any? {
        switch method {
        case "store.get":
            return ["value": store.get(try Bridge.string(p, "key")) as Any? ?? NSNull()]
        case "store.set":
            store.set(try Bridge.string(p, "key"), value: p["value"] as? String)
            return nil
        case "key.generate":
            let key = Curve25519.Signing.PrivateKey()
            return [
                "seed": key.rawRepresentation.base64EncodedString(),
                "publicKey": Bridge.openSSHPublicKey(key.publicKey, comment: "remote-agent-iphone")
            ]
        case "key.public":
            let key = try Bridge.generatedKey(try Bridge.string(p, "seed"))
            return ["publicKey": Bridge.openSSHPublicKey(key.publicKey, comment: "remote-agent-iphone")]
        case "ssh.connect":
            return try await connect(p)
        case "ssh.disconnect":
            await disconnect(try Bridge.string(p, "connId"))
            return nil
        case "ssh.exec":
            let conn = try connection(p)
            return try await Bridge.exec(
                client: conn.client,
                command: try Bridge.string(p, "command"),
                timeoutMs: Bridge.int(p["timeoutMs"]) ?? 30_000
            )
        case "term.open":
            return try await termOpen(p)
        case "term.close":
            if let term = terms[try Bridge.string(p, "termId")] {
                term.closedByUser = true
                term.task?.cancel()
            }
            return nil
        default:
            if let handler = extra[method] {
                return try await handler(p)
            }
            throw BridgeError("unknown-method", "unknown method \(method)")
        }
    }

    // MARK: - connections

    private func nextId(_ prefix: String) -> String {
        counter += 1
        return "\(prefix)\(counter)"
    }

    private func connection(_ p: [String: Any]) throws -> Connection {
        guard let conn = connections[try Bridge.string(p, "connId")], conn.client.isConnected else {
            throw BridgeError("not-connected", "not connected to the host")
        }
        return conn
    }

    private func connect(_ p: [String: Any]) async throws -> Any? {
        let host = try Bridge.string(p, "host")
        let username = try Bridge.string(p, "username")
        let port = Bridge.int(p["port"]) ?? 22
        let auth = p["auth"] as? [String: Any] ?? [:]
        let method = try Bridge.authentication(username: username, auth: auth)
        let validator = HostKeyCheck(pinned: p["pinnedHostKey"] as? String)

        let client: SSHClient
        do {
            client = try await SSHClient.connect(
                host: host,
                port: port,
                authenticationMethod: method,
                hostKeyValidator: .custom(validator),
                reconnect: .never,
                connectTimeout: .seconds(15)
            )
        } catch {
            if validator.mismatch, let seen = validator.seen {
                throw BridgeError(
                    "host-key-mismatch",
                    "The server's host key (\(seen)) does not match the one pinned for this host."
                )
            }
            if validator.seen != nil {
                // the transport came up and the key was accepted, so what failed is the login
                throw BridgeError("auth-failed", "Authentication failed (\(Bridge.describe(error))).")
            }
            throw BridgeError("conn-failed", "Could not connect to \(host):\(port) (\(Bridge.describe(error))).")
        }

        let id = nextId("c")
        connections[id] = Connection(id: id, client: client)
        client.onDisconnect { [weak self] in
            guard let self else { return }
            Task { await self.connectionLost(id) }
        }
        return ["connId": id, "hostKey": validator.seen ?? ""]
    }

    private func connectionLost(_ id: String) {
        guard connections.removeValue(forKey: id) != nil else { return }
        for term in terms.values where term.connId == id {
            term.task?.cancel()
        }
        emit(event: "ssh.closed", ["connId": id])
    }

    private func disconnect(_ id: String) async {
        guard let conn = connections.removeValue(forKey: id) else { return }
        for term in terms.values where term.connId == id {
            term.closedByUser = true
            term.task?.cancel()
        }
        try? await conn.client.close()
    }

    // MARK: - exec

    private static func exec(client: SSHClient, command: String, timeoutMs: Int) async throws -> [String: Any] {
        let work = Task { () -> (out: ByteBuffer, err: ByteBuffer, code: Int, truncated: Bool) in
            var out = ByteBuffer()
            var err = ByteBuffer()
            var code = 0
            var truncated = false
            do {
                let stream = try await client.executeCommandStream(command)
                for try await chunk in stream {
                    switch chunk {
                    case .stdout(var buffer):
                        if out.readableBytes + buffer.readableBytes > maxExecOutput {
                            truncated = true
                        } else {
                            out.writeBuffer(&buffer)
                        }
                    case .stderr(var buffer):
                        if err.readableBytes < 256 * 1024 { err.writeBuffer(&buffer) }
                    }
                }
            } catch let failed as SSHClient.CommandFailed {
                code = failed.exitCode
            }
            return (out, err, code, truncated)
        }
        let timer = Task {
            try await Task.sleep(nanoseconds: UInt64(max(timeoutMs, 1000)) * 1_000_000)
            work.cancel()
        }
        defer { timer.cancel() }

        let result: (out: ByteBuffer, err: ByteBuffer, code: Int, truncated: Bool)
        do {
            result = try await work.value
        } catch {
            if work.isCancelled { throw BridgeError("timeout", "the command timed out") }
            throw BridgeError("exec-failed", describe(error))
        }
        if work.isCancelled { throw BridgeError("timeout", "the command timed out") }
        return [
            "stdout": String(decoding: result.out.readableBytesView, as: UTF8.self),
            "stderr": String(decoding: result.err.readableBytesView, as: UTF8.self),
            "code": result.code,
            "truncated": result.truncated
        ]
    }

    // MARK: - terminals

    private func termOpen(_ p: [String: Any]) async throws -> Any? {
        let conn = try connection(p)
        let cols = max(Bridge.int(p["cols"]) ?? 80, 2)
        let rows = max(Bridge.int(p["rows"]) ?? 24, 2)
        let command = p["command"] as? String
        let id = nextId("t")

        let (inputs, inputContinuation) = AsyncStream<TermInput>.makeStream()
        let term = Term(id: id, connId: conn.id, input: inputContinuation)
        terms[id] = term

        let request = SSHChannelRequestEvent.PseudoTerminalRequest(
            wantReply: true,
            term: "xterm-256color",
            terminalCharacterWidth: cols,
            terminalRowHeight: rows,
            terminalPixelWidth: 0,
            terminalPixelHeight: 0,
            terminalModes: SSHTerminalModes([:])
        )
        let client = conn.client

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            term.ready = continuation
            term.task = Task { [weak self] in
                guard let self else { return }
                await self.runTerm(id: id, client: client, request: request, command: command, inputs: inputs)
            }
        }
        return ["termId": id]
    }

    private nonisolated func runTerm(
        id: String,
        client: SSHClient,
        request: SSHChannelRequestEvent.PseudoTerminalRequest,
        command: String?,
        inputs: AsyncStream<TermInput>
    ) async {
        var failure: String?
        // set once the remote end has finished on its own; closing the channel
        // after that reports "already closed", which is not a failure
        var ended = false
        do {
            try await client.withPTY(request) { inbound, outbound in
                let pump = Task {
                    for await input in inputs {
                        switch input {
                        case .data(let buffer):
                            try? await outbound.write(buffer)
                        case .resize(let cols, let rows):
                            try? await outbound.changeSize(cols: cols, rows: rows, pixelWidth: 0, pixelHeight: 0)
                        }
                    }
                }
                defer { pump.cancel() }
                if let command {
                    try await outbound.write(ByteBuffer(string: command + "\n"))
                }
                await self.termReady(id)
                for try await chunk in inbound {
                    switch chunk {
                    case .stdout(let buffer), .stderr(let buffer):
                        await self.termData(id, Array(buffer.readableBytesView))
                    }
                }
                ended = true
            }
        } catch is SSHClient.CommandFailed {
            // the remote shell exited non-zero: an ordinary end of the channel
        } catch is CancellationError {
            // closed from this side
        } catch {
            if !ended { failure = Bridge.describe(error) }
        }
        await termEnded(id, failure: failure)
    }

    private func termReady(_ id: String) {
        guard let term = terms[id], let ready = term.ready else { return }
        term.ready = nil
        ready.resume()
    }

    private func termData(_ id: String, _ bytes: [UInt8]) {
        guard let term = terms[id] else { return }
        term.pending.append(contentsOf: bytes)
        if term.pending.count >= Bridge.flushThreshold {
            flush(term)
        } else if !term.flushScheduled {
            term.flushScheduled = true
            Task {
                try? await Task.sleep(nanoseconds: Bridge.flushDelayNs)
                self.flushScheduled(id)
            }
        }
    }

    private func flushScheduled(_ id: String) {
        guard let term = terms[id] else { return }
        term.flushScheduled = false
        flush(term)
    }

    private func flush(_ term: Term) {
        guard !term.pending.isEmpty else { return }
        let data = Data(term.pending).base64EncodedString()
        term.pending.removeAll(keepingCapacity: true)
        emit(event: "term.data", ["termId": term.id, "data": data])
    }

    private func termEnded(_ id: String, failure: String?) {
        guard let term = terms.removeValue(forKey: id) else { return }
        flush(term)
        term.input.finish()
        if let ready = term.ready {
            term.ready = nil
            ready.resume(throwing: BridgeError("term-failed", failure ?? "the terminal channel closed"))
            return
        }
        var fields: [String: Any] = ["termId": id]
        if term.closedByUser {
            fields["reason"] = "closed"
        } else if connections[term.connId] == nil {
            fields["reason"] = "conn-lost"
        } else if let failure {
            fields["reason"] = "error"
            fields["message"] = failure
        } else {
            fields["reason"] = "detach"
        }
        emit(event: "term.exit", fields)
    }

    // MARK: - helpers

    private static func authentication(username: String, auth: [String: Any]) throws -> SSHAuthenticationMethod {
        switch auth["kind"] as? String {
        case "password":
            return .passwordBased(username: username, password: auth["password"] as? String ?? "")
        case "generated":
            return .ed25519(username: username, privateKey: try generatedKey(auth["seed"] as? String ?? ""))
        case "key":
            let text = auth["privateKey"] as? String ?? ""
            let passphrase = (auth["passphrase"] as? String).flatMap { $0.isEmpty ? nil : $0.data(using: .utf8) }
            if let key = try? Curve25519.Signing.PrivateKey(sshEd25519: text, decryptionKey: passphrase) {
                return .ed25519(username: username, privateKey: key)
            }
            if let key = try? Insecure.RSA.PrivateKey(sshRsa: text, decryptionKey: passphrase) {
                return .rsa(username: username, privateKey: key)
            }
            throw BridgeError(
                "bad-key",
                "Could not read the private key. Paste an OpenSSH-format ed25519 (or RSA) key, " +
                    "and check the passphrase."
            )
        default:
            throw BridgeError("bad-args", "unknown authentication kind")
        }
    }

    private static func generatedKey(_ seed: String) throws -> Curve25519.Signing.PrivateKey {
        guard let raw = Data(base64Encoded: seed),
              let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw)
        else { throw BridgeError("bad-key", "the stored key is unreadable") }
        return key
    }

    /// `ssh-ed25519 AAAA… comment`, the line that goes into authorized_keys.
    static func openSSHPublicKey(_ key: Curve25519.Signing.PublicKey, comment: String) -> String {
        var blob = Data()
        func append(_ bytes: Data) {
            var length = UInt32(bytes.count).bigEndian
            blob.append(Data(bytes: &length, count: 4))
            blob.append(bytes)
        }
        append(Data("ssh-ed25519".utf8))
        append(key.rawRepresentation)
        return "ssh-ed25519 \(blob.base64EncodedString()) \(comment)"
    }

    private static func string(_ p: [String: Any], _ key: String) throws -> String {
        guard let value = p[key] as? String else {
            throw BridgeError("bad-args", "missing \(key)")
        }
        return value
    }

    private static func int(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        if let value = value as? Double { return Int(value) }
        if let value = value as? NSNumber { return value.intValue }
        return nil
    }

    private static func describe(_ error: Error) -> String {
        if let error = error as? BridgeError { return error.message }
        return String(describing: error)
    }

    private static func json(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8)
        else { return "{}" }
        return text
    }
}

/// Trust-on-first-use: records the key the server presents and, when a
/// fingerprint is already pinned for the host, refuses any other.
final class HostKeyCheck: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {
    private let pinned: String?
    private let lock = NSLock()
    private var _seen: String?
    private var _mismatch = false

    init(pinned: String?) {
        self.pinned = (pinned?.isEmpty ?? true) ? nil : pinned
    }

    var seen: String? {
        lock.lock()
        defer { lock.unlock() }
        return _seen
    }

    var mismatch: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _mismatch
    }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let fingerprint = HostKeyCheck.fingerprint(hostKey)
        let ok = pinned == nil || pinned == fingerprint
        lock.lock()
        _seen = fingerprint
        _mismatch = !ok
        lock.unlock()
        if ok {
            validationCompletePromise.succeed(())
        } else {
            validationCompletePromise.fail(BridgeError("host-key-mismatch", "host key mismatch"))
        }
    }

    /// OpenSSH-style `SHA256:<base64, unpadded>` of the public key blob.
    static func fingerprint(_ key: NIOSSHPublicKey) -> String {
        let line = String(openSSHPublicKey: key)
        let parts = line.split(separator: " ")
        guard parts.count >= 2, let blob = Data(base64Encoded: String(parts[1])) else {
            return "SHA256:unknown"
        }
        let digest = Data(SHA256.hash(data: blob)).base64EncodedString()
        return "SHA256:" + digest.replacingOccurrences(of: "=", with: "")
    }
}
