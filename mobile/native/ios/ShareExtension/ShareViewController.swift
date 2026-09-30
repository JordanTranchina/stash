//  ShareViewController.swift
//  Stash Share Extension (iOS)
//
//  The whole extension: take whatever the user shared from any app's share
//  sheet, reduce it to a URL plus an optional title, and hand it to the Stash
//  app through the stash:// scheme. The extension deliberately does no saving
//  of its own — web/platform.js routes the deep link to app.js's
//  handleNativeShare, which uses the same save-page Edge Function the PWA
//  share target and the browser extensions use. One ingestion path, one set of
//  behaviours (dedupe, offline queueing, Readability extraction) for every
//  client.
//
//  There is no storyboard: the extension has no UI of its own, so it presents
//  nothing and returns immediately. NSExtensionPrincipalClass in Info.plist
//  points straight at this class.

import UIKit
import Social
import UniformTypeIdentifiers

class ShareViewController: UIViewController {

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        handleSharedItem()
    }

    private func handleSharedItem() {
        guard let item = extensionContext?.inputItems.first as? NSExtensionItem,
              let attachments = item.attachments else {
            complete()
            return
        }

        // A share carries the same link under several type identifiers, and
        // which ones appear depends on the sending app: Safari offers a real
        // URL, most other apps offer plain text that happens to contain one.
        // Prefer the URL, fall back to text, and let the app's own extractor
        // pull the link out of the text case.
        let title = item.attributedContentText?.string

        for provider in attachments where provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] value, _ in
                let url = (value as? URL)?.absoluteString
                self?.openApp(url: url, text: nil, title: title)
            }
            return
        }

        for provider in attachments where provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { [weak self] value, _ in
                self?.openApp(url: nil, text: value as? String, title: title)
            }
            return
        }

        complete()
    }

    private func openApp(url: String?, text: String?, title: String?) {
        var components = URLComponents()
        components.scheme = "stash"
        components.host = "share"
        var query: [URLQueryItem] = []
        if let url = url { query.append(URLQueryItem(name: "url", value: url)) }
        if let text = text { query.append(URLQueryItem(name: "text", value: text)) }
        if let title = title, !title.isEmpty { query.append(URLQueryItem(name: "title", value: title)) }
        components.queryItems = query

        guard let deepLink = components.url else {
            complete()
            return
        }

        DispatchQueue.main.async { [weak self] in
            self?.open(deepLink)
            self?.complete()
        }
    }

    // A share extension has no UIApplication.shared of its own, so opening the
    // host app means walking up the responder chain to something that does
    // respond to open(_:options:completionHandler:). This is the long-standing
    // way to do it and is why the selector is built by hand.
    private func open(_ url: URL) {
        var responder: UIResponder? = self
        let selector = sel_registerName("openURL:options:completionHandler:")
        while let current = responder {
            if current.responds(to: selector), let application = current as? UIApplication {
                application.open(url, options: [:], completionHandler: nil)
                return
            }
            responder = current.next
        }
    }

    private func complete() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
