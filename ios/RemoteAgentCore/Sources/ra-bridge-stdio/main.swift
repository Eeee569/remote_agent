// Development harness: the same Bridge the iPhone app embeds, speaking its JSON
// protocol over stdin/stdout (one message per line). ios/dev/server.mjs puts the
// web UI on top of it so the whole stack can be exercised without a device.
import Foundation
import RemoteAgentCore

final class FileStore: BridgeStore {
    private let url: URL
    private var values: [String: String] = [:]
    private let lock = NSLock()

    init(path: String) {
        url = URL(fileURLWithPath: path)
        if let data = try? Data(contentsOf: url),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            values = object
        }
    }

    func get(_ key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[key]
    }

    func set(_ key: String, value: String?) {
        lock.lock()
        defer { lock.unlock() }
        values[key] = value
        if let data = try? JSONSerialization.data(withJSONObject: values) {
            try? data.write(to: url)
        }
    }
}

let storePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/ra-bridge-store.json"
let outLock = NSLock()
let bridge = Bridge(store: FileStore(path: storePath)) { line in
    outLock.lock()
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
    outLock.unlock()
}

while let line = readLine(strippingNewline: true) {
    if !line.isEmpty { bridge.handle(message: line) }
}
