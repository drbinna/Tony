// drive — Tony's hands. CGEvent input synthesis with a built-in deadman.
//
// SCOPE B, SANDBOX ONLY. The brain's sanitizeAction() demotes every mutating
// action to a point on non-sandbox accounts BEFORE anything reaches this
// binary; that gate lives in code, not in the prompt, and not here — this
// helper does what it is told, so nothing but the gated main process may
// spawn it.
//
// THE DEADMAN LIVES AT THE LOWEST LEVEL. Every event this helper posts is
// tagged with a magic value in its eventSourceUserData field. A listen-only
// event tap watches ALL hid input; any key/mouse/scroll event WITHOUT the tag
// is the learner's real hand, and the gesture aborts immediately (exit 2).
// The learner always wins the race for the wheel — that is the product's
// safety promise ("You moved, I stopped. House rules.").
//
// Usage: drive '<json>'
//   {"kind":"click","x":640,"y":400}
//   {"kind":"type","text":"hello"}          (target must already be focused)
//   {"kind":"scroll","x":640,"y":400,"direction":"down"}
//
// Exit codes: 0 done · 2 deadman abort · 1 bad invocation/permission.

import AppKit
import ApplicationServices

let MAGIC: Int64 = 0x70_6E_79   // "tny" — tags every synthesized event

// ---------------------------------------------------------------- deadman

final class Deadman {
    static let aborted = NSLock()   // lock held = abort flagged
    static var isAborted = false

    static func arm() -> Bool {
        let mask: CGEventMask =
            (1 << CGEventType.keyDown.rawValue) |
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.rightMouseDown.rawValue) |
            (1 << CGEventType.otherMouseDown.rawValue) |
            (1 << CGEventType.scrollWheel.rawValue) |
            (1 << CGEventType.mouseMoved.rawValue) |
            (1 << CGEventType.leftMouseDragged.rawValue)

        guard let tap = CGEvent.tapCreate(
            tap: .cghidEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: { _, _, event, _ in
                if event.getIntegerValueField(.eventSourceUserData) != MAGIC {
                    // Real human input while Tony drives: stop mid-gesture.
                    // exit(2) from the tap thread is deliberate — faster than
                    // any flag polling, and the main process treats 2 as the
                    // deadman code.
                    exit(2)
                }
                return Unmanaged.passUnretained(event)
            },
            userInfo: nil
        ) else { return false }

        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }
}

// ---------------------------------------------------------------- posting

func post(_ event: CGEvent) {
    event.setIntegerValueField(.eventSourceUserData, value: MAGIC)
    // Session tap, not HID tap: on macOS 26 user-space posts to the HID entry
    // point return success and are silently DISCARDED — measured live (cursor
    // did not move, click did not land, exit 0). Session-level posting works.
    event.post(tap: .cgSessionEventTap)
}

func currentMouse() -> CGPoint {
    CGEvent(source: nil)?.location ?? CGPoint(x: 0, y: 0)
}

/// Eased glide so the learner SEES the cursor travel to the target. An
/// instant teleport reads as a glitch; a 400ms glide reads as a hand.
func glide(to target: CGPoint) {
    let from = currentMouse()
    let steps = 28
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let e = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2   // easeInOutQuad
        let p = CGPoint(x: from.x + (target.x - from.x) * e,
                        y: from.y + (target.y - from.y) * e)
        // Warp moves the VISIBLE cursor (posting mouseMoved alone does not on
        // this macOS); the posted event delivers hover to the app underneath.
        CGWarpMouseCursorPosition(p)
        if let m = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                           mouseCursorPosition: p, mouseButton: .left) {
            post(m)
        }
        usleep(14_000)   // ~400ms total
    }
}

/// Delivery self-check. Warp + posting can silently no-op depending on how
/// this process was spawned (measured live: CLI-spawned moves worked while
/// Electron-spawned ones reported ok and moved nothing). Exit 3 = the cursor
/// did not actually arrive; the caller must not claim the gesture happened.
func verifyArrived(_ target: CGPoint) {
    let now = currentMouse()
    if abs(now.x - target.x) > 8 || abs(now.y - target.y) > 8 {
        FileHandle.standardError.write(Data(
            "drive: DELIVERY BLOCKED — cursor at \(Int(now.x)),\(Int(now.y)), target \(Int(target.x)),\(Int(target.y))\n".utf8))
        exit(3)
    }
}

func click(at p: CGPoint) {
    glide(to: p)
    verifyArrived(p)
    usleep(90_000)   // beat between arrival and click; reads as intent
    if let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                          mouseCursorPosition: p, mouseButton: .left) {
        post(down)
    }
    usleep(60_000)
    if let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                        mouseCursorPosition: p, mouseButton: .left) {
        post(up)
    }
}

func typeText(_ text: String) {
    // Unicode injection: no keycode tables, works for any character. Chunked
    // per character with a human-ish cadence so the page's key handlers fire
    // in order (Cloudscape search boxes debounce per keystroke).
    for ch in text {
        let s = String(ch)
        let units = Array(s.utf16)
        if let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) {
            down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            post(down)
        }
        if let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
            up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            post(up)
        }
        usleep(24_000)
    }
}

func scroll(at p: CGPoint, direction: String) {
    glide(to: p)
    let delta: Int32 = direction == "up" ? 6 : -6
    for _ in 0..<5 {
        if let s = CGEvent(scrollWheelEvent2Source: nil, units: .line,
                           wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0) {
            post(s)
        }
        usleep(40_000)
    }
}

// ------------------------------------------------------------------ main

guard AXIsProcessTrusted() else {
    FileHandle.standardError.write(Data("drive: accessibility permission denied\n".utf8))
    exit(1)
}

guard CommandLine.arguments.count == 2,
      let data = CommandLine.arguments[1].data(using: .utf8),
      let cmd = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let kind = cmd["kind"] as? String else {
    FileHandle.standardError.write(Data("drive: usage: drive '<json>'\n".utf8))
    exit(1)
}

guard Deadman.arm() else {
    FileHandle.standardError.write(Data("drive: could not create event tap\n".utf8))
    exit(1)
}

// Synthesis runs off-main so the tap's runloop stays responsive; the whole
// gesture is bounded so a wedged page can never hold the wheel.
DispatchQueue.global().async {
    switch kind {
    case "move":   // glide only, no click — gesture/test path
        guard let x = cmd["x"] as? Double, let y = cmd["y"] as? Double else { exit(1) }
        glide(to: CGPoint(x: x, y: y))
        verifyArrived(CGPoint(x: x, y: y))
    case "click":
        guard let x = cmd["x"] as? Double, let y = cmd["y"] as? Double else { exit(1) }
        click(at: CGPoint(x: x, y: y))
    case "type":
        guard let text = cmd["text"] as? String, text.count <= 500 else { exit(1) }
        typeText(text)
    case "scroll":
        guard let x = cmd["x"] as? Double, let y = cmd["y"] as? Double else { exit(1) }
        scroll(at: CGPoint(x: x, y: y), direction: (cmd["direction"] as? String) ?? "down")
    default:
        exit(1)
    }
    exit(0)
}

// Watchdog: no single gesture may hold the wheel longer than 15s.
DispatchQueue.global().asyncAfter(deadline: .now() + 15) { exit(1) }
CFRunLoopRun()
