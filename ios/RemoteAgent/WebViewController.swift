import RemoteAgentCore
import UIKit
import WebKit

/// Hosts the app's UI (web/index.html, built from ios/web) in a WKWebView and
/// connects it to the SSH bridge:
///
///   page -> native   window.webkit.messageHandlers.ra.postMessage(json)
///   native -> page   window.__raReceive(json)
final class WebViewController: UIViewController, WKScriptMessageHandler {
    private var webView: WKWebView!
    private var bridge: Bridge!
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    private static let background = UIColor(red: 0.094, green: 0.094, blue: 0.094, alpha: 1)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = WebViewController.background

        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "ra")

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = WebViewController.background
        webView.scrollView.backgroundColor = WebViewController.background
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        #if DEBUG
        if #available(iOS 16.4, *) {
            // lets Safari's Web Inspector on the Mac attach while developing
            webView.isInspectable = true
        }
        #endif

        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            // End the page at the top of the keyboard instead of letting the
            // keyboard cover it: the terminal and its key bar then always sit
            // directly above the keys, with no scrolling tricks in the page.
            webView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        ])

        let bridge = Bridge(store: KeychainStore()) { [weak self] json in
            DispatchQueue.main.async { [weak self] in
                self?.webView.evaluateJavaScript("window.__raReceive(\(json))", completionHandler: nil)
            }
        }
        self.bridge = bridge

        Task {
            await bridge.register("clipboard.read") { _ in
                let text = await MainActor.run { UIPasteboard.general.string ?? "" }
                return ["text": text] as [String: Any]
            }
            await bridge.register("clipboard.write") { params in
                let text = params["text"] as? String ?? ""
                await MainActor.run { UIPasteboard.general.string = text }
                return nil
            }
            await MainActor.run { self.loadPage() }
        }

        let center = NotificationCenter.default
        center.addObserver(
            self, selector: #selector(didBecomeActive),
            name: UIApplication.didBecomeActiveNotification, object: nil
        )
        center.addObserver(
            self, selector: #selector(didEnterBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil
        )
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    private func loadPage() {
        let bundle = Bundle.main
        guard let url = bundle.url(forResource: "index", withExtension: "html", subdirectory: "web")
            ?? bundle.url(forResource: "index", withExtension: "html")
        else {
            webView.loadHTMLString(
                "<body style='background:#181818;color:#ccc;font:16px -apple-system;padding:80px 24px'>"
                    + "web/index.html is missing from the app bundle.</body>",
                baseURL: nil
            )
            return
        }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    // MARK: - page -> native

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let text = message.body as? String else { return }
        bridge.handle(message: text)
    }

    // MARK: - lifecycle

    /// iOS suspends a backgrounded app and its sockets die. Ask for the short
    /// grace period it offers so a quick app switch keeps the SSH connection;
    /// on return the page checks the connection and reconnects if it is gone.
    @objc private func didEnterBackground() {
        endBackgroundTask()
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "ssh-grace") { [weak self] in
            self?.endBackgroundTask()
        }
    }

    @objc private func didBecomeActive() {
        endBackgroundTask()
        bridge.emit(event: "app.foreground")
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
}
