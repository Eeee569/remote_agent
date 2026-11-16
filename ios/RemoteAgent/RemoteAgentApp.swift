import SwiftUI

@main
struct RemoteAgentApp: App {
    var body: some Scene {
        WindowGroup {
            WebScreen()
                // the web view sizes itself against the keyboard (see
                // WebViewController), so SwiftUI must not move it as well
                .ignoresSafeArea()
                .background(Color(red: 0.094, green: 0.094, blue: 0.094))
                .preferredColorScheme(.dark)
        }
    }
}

struct WebScreen: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebViewController {
        WebViewController()
    }

    func updateUIViewController(_ controller: WebViewController, context: Context) {}
}
