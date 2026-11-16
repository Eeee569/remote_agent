// swift-tools-version:5.9
import PackageDescription

// The SSH half of the iPhone app, kept free of UIKit/WebKit so it also builds
// and runs on Linux (`swift build`), where ios/dev drives it against a real sshd.
let package = Package(
    name: "RemoteAgentCore",
    platforms: [
        .iOS(.v15),
        .macOS("15.0")
    ],
    products: [
        .library(name: "RemoteAgentCore", targets: ["RemoteAgentCore"])
    ],
    dependencies: [
        // Pinned: 0.11.x still supports iOS 14+, later releases need iOS 17.
        .package(url: "https://github.com/orlandos-nl/Citadel.git", exact: "0.11.1"),
        .package(url: "https://github.com/Joannis/swift-nio-ssh.git", "0.3.4" ..< "0.4.0"),
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.50.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", "3.12.3" ..< "4.0.0")
    ],
    targets: [
        .target(
            name: "RemoteAgentCore",
            dependencies: [
                .product(name: "Citadel", package: "Citadel"),
                .product(name: "NIOSSH", package: "swift-nio-ssh"),
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "Crypto", package: "swift-crypto")
            ]
        ),
        .executableTarget(
            name: "ra-bridge-stdio",
            dependencies: ["RemoteAgentCore"]
        )
    ]
)
