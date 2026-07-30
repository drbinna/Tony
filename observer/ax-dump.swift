// ax-dump.swift — serialize the frontmost window's accessibility tree to JSON.
//
// This is Tony's primary sense. It is deterministic, cheap, and runs on every
// tick; the vision fallback only fires when this cannot answer.
//
// Build:  ./build.sh          (needs Xcode command line tools)
// Run:    ./ax-dump           -> one JSON object on stdout
//
// Requires Accessibility permission:
//   System Settings > Privacy & Security > Accessibility > enable the host app.
//
// Note: Chromium only populates its native AX tree when an assistive client is
// detected. Reading the tree is itself the trigger, but the first read after
// launch may come back sparse — retry once before concluding the tree is empty.

import AppKit
import ApplicationServices

let MAX_DEPTH = 22
let MAX_NODES = 400

struct Node: Encodable {
    let id: String
    let role: String
    let label: String
    let value: String
    let bounds: [Int]   // [x, y, w, h] in screen coords
}

var nodes: [Node] = []
var counter = 0

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var out: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &out) == .success ? out : nil
}

func str(_ el: AXUIElement, _ name: String) -> String {
    guard let v = attr(el, name) else { return "" }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
}

func frame(_ el: AXUIElement) -> [Int] {
    guard let posRef = attr(el, kAXPositionAttribute as String),
          let sizeRef = attr(el, kAXSizeAttribute as String) else { return [] }
    var p = CGPoint.zero
    var s = CGSize.zero
    AXValueGetValue(posRef as! AXValue, .cgPoint, &p)
    AXValueGetValue(sizeRef as! AXValue, .cgSize, &s)
    return [Int(p.x), Int(p.y), Int(s.width), Int(s.height)]
}

/// Roles that carry no semantic weight for tutoring. Dropping them keeps the
/// serialized tree small enough to sit in a prompt on every tick.
let SKIP: Set<String> = [
    "AXSplitter", "AXGrowArea", "AXScrollBar", "AXValueIndicator", "AXUnknown",
]

func interesting(_ role: String, _ label: String, _ value: String) -> Bool {
    if SKIP.contains(role) { return false }
    let actionable: Set<String> = [
        "AXButton", "AXTextField", "AXTextArea", "AXPopUpButton", "AXCheckBox",
        "AXRadioButton", "AXComboBox", "AXLink", "AXMenuItem", "AXSlider", "AXTab",
    ]
    if actionable.contains(role) { return true }
    // keep static text only when it actually says something
    if role == "AXStaticText" || role == "AXHeading" {
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    return false
}

func walk(_ el: AXUIElement, depth: Int) {
    if depth > MAX_DEPTH || nodes.count >= MAX_NODES { return }

    let role = str(el, kAXRoleAttribute as String)
    let label = [
        str(el, kAXTitleAttribute as String),
        str(el, kAXDescriptionAttribute as String),
        str(el, "AXPlaceholderValue"),
    ].first(where: { !$0.isEmpty }) ?? ""
    var value = str(el, kAXValueAttribute as String)
    if value.isEmpty { value = str(el, kAXTitleAttribute as String) }
    if value.count > 160 { value = String(value.prefix(160)) }

    if interesting(role, label, value) {
        nodes.append(Node(id: "e\(counter)",
                          role: role.replacingOccurrences(of: "AX", with: "").lowercased(),
                          label: label, value: value, bounds: frame(el)))
        counter += 1
    }

    if let kids = attr(el, kAXChildrenAttribute as String) as? [AXUIElement] {
        for k in kids { walk(k, depth: depth + 1) }
    }
}

// ---------------------------------------------------------------- main

guard AXIsProcessTrusted() else {
    print(#"{"error":"accessibility_permission_denied"}"#)
    exit(2)
}

guard let app = NSWorkspace.shared.frontmostApplication else {
    print(#"{"error":"no_frontmost_app"}"#)
    exit(1)
}

let axApp = AXUIElementCreateApplication(app.processIdentifier)
var windowTitle = ""
var documentURL = ""

/// Browsers expose the live URL via AXDocument on the window, and AXURL on the
/// web area. This is FAR more reliable than sniffing window titles: AWS console
/// titles vary per service and per page ("Console Home", "Launch an instance |
/// EC2 | us-west-2") and none of them reliably contain the word "AWS".
func findURL(_ el: AXUIElement, depth: Int) -> String {
    if depth > 6 { return "" }
    if let doc = attr(el, kAXDocumentAttribute as String) as? String, !doc.isEmpty { return doc }
    if let u = attr(el, "AXURL") {
        if let url = u as? URL { return url.absoluteString }
        if let s = u as? String, !s.isEmpty { return s }
    }
    if let kids = attr(el, kAXChildrenAttribute as String) as? [AXUIElement] {
        for k in kids {
            let found = findURL(k, depth: depth + 1)
            if !found.isEmpty { return found }
        }
    }
    return ""
}

if let win = attr(axApp, kAXFocusedWindowAttribute as String) {
    let w = win as! AXUIElement
    windowTitle = str(w, kAXTitleAttribute as String)
    documentURL = findURL(w, depth: 0)
    walk(w, depth: 0)
} else {
    walk(axApp, depth: 0)
}

struct Payload: Encodable {
    let frontmost_app: String
    let window_title: String
    let document_url: String
    let captured_at: Double
    let truncated: Bool
    let a11y_tree: [Node]
}

let payload = Payload(
    frontmost_app: app.localizedName ?? "unknown",
    window_title: windowTitle,
    document_url: documentURL,
    captured_at: Date().timeIntervalSince1970,
    truncated: nodes.count >= MAX_NODES,
    a11y_tree: nodes
)

let enc = JSONEncoder()
if let data = try? enc.encode(payload), let s = String(data: data, encoding: .utf8) {
    print(s)
} else {
    print(#"{"error":"encode_failed"}"#)
    exit(1)
}
