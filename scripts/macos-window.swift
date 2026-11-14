// Helper for scripts/capture-all-screenshots.mjs.
//
// Looks up an application window by owner name (CoreGraphics), and drives the
// Accessibility API for the three things a capture needs: a known window size,
// the current appearance, and the appearance toggle. Subcommands print JSON on
// stdout and exit non-zero on failure, so the Node script keeps all
// orchestration and messaging.
//
// Usage:
//   macos-window find <owner-substring>
//   macos-window resize <owner-substring> <width> <height>
//   macos-window press <owner-substring> <label-substring>
//   macos-window appearance <owner-substring> [light|dark|system]
//   macos-window trust

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

func jsonLine(_ pairs: [(String, Any)]) -> Never {
    let body = pairs
        .map { "\"\($0.0)\":\($0.1 is String ? "\"\($0.1)\"" : "\($0.1)")" }
        .joined(separator: ",")
    print("{\(body)}")
    exit(0)
}

/// First on-screen window at least 200pt wide whose owner name matches.
func findWindow(ownerContains: String) -> (id: CGWindowID, bounds: CGRect, owner: String) {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        fail("CoreGraphics returned no window list")
    }
    let needle = ownerContains.lowercased()
    for entry in list {
        guard let owner = entry[kCGWindowOwnerName as String] as? String,
              owner.lowercased().contains(needle),
              let number = entry[kCGWindowNumber as String] as? Int,
              let raw = entry[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
        let bounds = CGRect(
            x: raw["X"] ?? 0,
            y: raw["Y"] ?? 0,
            width: raw["Width"] ?? 0,
            height: raw["Height"] ?? 0
        )
        // Menus, tooltips and the like are narrow; the app window is not.
        guard bounds.width >= 200 else { continue }
        return (CGWindowID(number), bounds, owner)
    }
    fail("No on-screen window for an app matching \"\(ownerContains)\"", code: 2)
}

func runningApp(ownerContains: String) -> NSRunningApplication {
    let needle = ownerContains.lowercased()
    let matches = NSWorkspace.shared.runningApplications.filter { app in
        guard let name = app.localizedName?.lowercased() else { return false }
        return name.contains(needle)
    }
    guard let app = matches.first else {
        fail("No running app matching \"\(ownerContains)\"", code: 2)
    }
    return app
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func elementText(_ element: AXUIElement) -> [String] {
    [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute].compactMap {
        attribute(element, $0) as? String
    }
}

func firstWindow(_ app: NSRunningApplication) -> AXUIElement {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    guard let windows = attribute(element, kAXWindowsAttribute) as? [AXUIElement],
          let window = windows.first else {
        fail("App has no accessible windows (is Accessibility permission granted?)")
    }
    return window
}

/// Depth-first search for a pressable control whose title, description or help
/// text contains `label`. Buttons and checkboxes both count: the view toggles
/// are exposed as `AXCheckBox`, and pressing one is how you switch layout.
/// Every pressable control whose text contains `label`, in tree order.
func collectControls(_ element: AXUIElement, label: String, into found: inout [AXUIElement], depth: Int = 0) {
    if depth > 40 || found.count >= 80 { return }
    let role = attribute(element, kAXRoleAttribute) as? String ?? ""
    if interactiveRoles.contains(role),
       elementText(element).contains(where: { $0.localizedCaseInsensitiveContains(label) }) {
        found.append(element)
    }
    guard let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { return }
    for child in children {
        collectControls(child, label: label, into: &found, depth: depth + 1)
    }
}

/// Best match for `label`: an exact text wins over a prefix, which wins over a
/// substring, and among equals the shortest text wins. Without this, pressing
/// "Library" would hit the "Library stats" popup instead of the sidebar item.
func findControl(_ element: AXUIElement, label: String) -> AXUIElement? {
    var candidates: [AXUIElement] = []
    collectControls(element, label: label, into: &candidates)
    var best: (rank: Int, length: Int, element: AXUIElement)?
    for candidate in candidates {
        for text in elementText(candidate) {
            let lower = text.lowercased()
            let needle = label.lowercased()
            let rank = lower == needle ? 0 : lower.hasPrefix(needle) ? 1 : 2
            let score = (rank, text.count)
            if best == nil || score < (best!.rank, best!.length) {
                best = (rank, text.count, candidate)
            }
        }
    }
    return best?.element
}

/// The top-bar button reads "Appearance: Light. Switch to Dark".
func collectText(_ element: AXUIElement, into found: inout [(role: String, text: String)], depth: Int = 0) {
    if depth > 40 || found.count >= 120 { return }
    let role = attribute(element, kAXRoleAttribute) as? String ?? ""
    if role == kAXStaticTextRole as String || role == kAXHeadingRole as String {
        if let value = attribute(element, kAXValueAttribute) as? String, !value.isEmpty {
            found.append((role, value))
        }
    }
    guard let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { return }
    for child in children {
        collectText(child, into: &found, depth: depth + 1)
    }
}

func findControlPrefix(_ element: AXUIElement, prefix: String, depth: Int = 0) -> AXUIElement? {
    if depth > 40 { return nil }
    let role = attribute(element, kAXRoleAttribute) as? String ?? ""
    if interactiveRoles.contains(role),
       let first = elementText(element).first,
       first.lowercased().hasPrefix(prefix.lowercased()) {
        return element
    }
    guard let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { return nil }
    for child in children {
        if let found = findControlPrefix(child, prefix: prefix, depth: depth + 1) { return found }
    }
    return nil
}

func currentAppearance(_ window: AXUIElement) -> String? {
    guard let button = findControl(window, label: "Appearance:") else { return nil }
    guard let text = elementText(button).first else { return nil }
    // The button reads "Appearance: <Current>. Switch to <Next>", so the
    // current value is the word right after "Appearance:". Matching the
    // bare name (System before Light/Dark) false-positives on the "Switch
    // to ..." half of the label.
    for name in ["Light", "Dark", "System"] where text.contains("Appearance: \(name)") {
        return name
    }
    return nil
}

func press(_ element: AXUIElement) -> Bool {
    AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

// Marks that can be driven: buttons, checkboxes, tabs and pop-up buttons.
let interactiveRoles: Set<String> = [
    kAXButtonRole as String,
    kAXCheckBoxRole as String,
    kAXRadioButtonRole as String,
    kAXTabGroupRole as String,
    kAXPopUpButtonRole as String,
]

/// Every pressable label in the window, in tree order. Recipes are written
/// against these strings, so a failed step can print the real list.
func collectLabels(_ element: AXUIElement, into found: inout [(role: String, text: String)], depth: Int = 0) {
    if depth > 40 || found.count >= 400 { return }
    let role = attribute(element, kAXRoleAttribute) as? String ?? "?"
    if interactiveRoles.contains(role) {
        let texts = elementText(element)
        if let primary = texts.first, !primary.isEmpty {
            let value = (attribute(element, kAXValueAttribute) as? String) ?? ""
            found.append((role, value.isEmpty ? primary : "\(primary) [\(value)]"))
        }
    }
    guard let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { return }
    for child in children {
        collectLabels(child, into: &found, depth: depth + 1)
    }
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: macos-window <find|resize|press|appearance|trust> ...") }

switch args[1] {
case "trust":
    let trusted = AXIsProcessTrusted()
    print("{\"accessibilityTrusted\":\(trusted)}")
    exit(trusted ? 0 : 3)

case "find":
    guard args.count >= 3 else { fail("usage: macos-window find <owner-substring>") }
    let window = findWindow(ownerContains: args[2])
    jsonLine([
        ("windowId", Int(window.id)),
        ("owner", window.owner),
        ("x", Double(window.bounds.origin.x)),
        ("y", Double(window.bounds.origin.y)),
        ("width", Double(window.bounds.width)),
        ("height", Double(window.bounds.height)),
    ])

case "resize":
    guard args.count >= 5,
          let width = Double(args[3]),
          let height = Double(args[4]) else {
        fail("usage: macos-window resize <owner-substring> <width> <height>")
    }
    let app = runningApp(ownerContains: args[2])
    let window = firstWindow(app)
    var size = CGSize(width: width, height: height)
    guard let sizeValue = AXValueCreate(.cgSize, &size) else { fail("Could not build size value") }
    guard AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue) == .success else {
        fail("Could not resize the window (Accessibility permission?)")
    }
    print("{\"width\":\(width),\"height\":\(height)}")
    exit(0)

case "press":
    guard args.count >= 4 else { fail("usage: macos-window press <owner-substring> <label-substring>") }
    let app = runningApp(ownerContains: args[2])
    let window = firstWindow(app)
    guard let button = findControl(window, label: args[3]) else {
        fail("No button whose label contains \"\(args[3])\"")
    }
    guard press(button) else { fail("Could not press the button") }
    print("{\"pressed\":\"\(args[3])\"}")
    exit(0)

case "dump":
    guard args.count >= 3 else { fail("usage: macos-window dump <owner-substring>") }
    let app = runningApp(ownerContains: args[2])
    let window = firstWindow(app)
    var found: [(role: String, text: String)] = []
    collectLabels(window, into: &found)
    for entry in found {
        let escaped = entry.text.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        print("{\"role\":\"\(entry.role)\",\"text\":\"\(escaped)\"}")
    }
    exit(0)

case "dblclick-prefix":
    // Tiles open the viewer on double-click, and AX has no double-press: post
    // two real clicks at the control's centre instead.
    guard args.count >= 4 else { fail("usage: macos-window dblclick-prefix <owner-substring> <prefix>") }
    let app = runningApp(ownerContains: args[2])
    app.activate(options: [.activateAllWindows])
    usleep(300_000)
    let window = firstWindow(app)
    guard let target = findControlPrefix(window, prefix: args[3]) else {
        fail("No control whose label starts with \"\(args[3])\"")
    }
    var point = CGPoint.zero
    var size = CGSize.zero
    if let rawPoint = attribute(target, kAXPositionAttribute) {
        AXValueGetValue(rawPoint as! AXValue, .cgPoint, &point)
    }
    if let rawSize = attribute(target, kAXSizeAttribute) {
        AXValueGetValue(rawSize as! AXValue, .cgSize, &size)
    }
    guard size.width > 0, size.height > 0 else { fail("The target has no on-screen frame") }
    // AX positions are top-left-origin; CGEvent wants bottom-left-origin screen
    // points, so the y axis has to be mirrored against the display height.
    let displayHeight = CGDisplayBounds(CGMainDisplayID()).height
    let centre = CGPoint(
        x: point.x + size.width / 2,
        y: displayHeight - (point.y + size.height / 2)
    )
    let source = CGEventSource(stateID: .hidSystemState)
    for click in 1...2 {
        for down in [true, false] {
            guard let event = CGEvent(
                mouseEventSource: source,
                mouseType: down ? .leftMouseDown : .leftMouseUp,
                mouseCursorPosition: centre,
                mouseButton: .left
            ) else { fail("could not build the click event") }
            event.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            event.post(tap: .cghidEventTap)
            usleep(40_000)
        }
    }
    print("{\"doubleClicked\":\"\(args[3])\",\"x\":\(centre.x),\"y\":\(centre.y)}")
    exit(0)

case "key":
    // Some transitions are keyboard-driven (Return opens the viewer on the
    // selected item, Escape closes a dialog), and there is no pressable control.
    guard args.count >= 4 else { fail("usage: macos-window key <owner-substring> <key>") }
    let app = runningApp(ownerContains: args[2])
    app.activate(options: [.activateAllWindows])
    let codes: [String: CGKeyCode] = [
        "return": 36, "escape": 53, "space": 49, "tab": 48,
        "left": 123, "right": 124, "up": 126, "down": 125,
    ]
    guard let code = codes[args[3].lowercased()] else {
        fail("unknown key; use \(codes.keys.sorted().joined(separator: ", "))")
    }
    let withCommand = args.count >= 5 && args[4].lowercased() == "meta"
    let source = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else {
            fail("could not build the key event")
        }
        if withCommand { event.flags = .maskCommand }
        event.post(tap: .cghidEventTap)
        usleep(60_000)
    }
    print("{\"key\":\"\(args[3])\",\"command\":\(withCommand)}")
    exit(0)

case "activate":
    // Accessibility presses land more reliably when the window is frontmost;
    // a background window can swallow the action.
    guard args.count >= 3 else { fail("usage: macos-window activate <owner-substring>") }
    let app = runningApp(ownerContains: args[2])
    app.activate(options: [.activateAllWindows])
    usleep(400_000)
    print("{\"active\":\(app.isActive)}")
    exit(0)

case "press-prefix":
    // Presses the first control whose label starts with a prefix, for targets
    // whose full label is data ("Open <filename>", album covers, drafts).
    guard args.count >= 4 else { fail("usage: macos-window press-prefix <owner-substring> <prefix>") }
    let app = runningApp(ownerContains: args[2])
    let window = firstWindow(app)
    guard let button = findControlPrefix(window, prefix: args[3]) else {
        fail("No control whose label starts with \"\(args[3])\"")
    }
    guard press(button) else { fail("Could not press the control") }
    print("{\"pressedPrefix\":\"\(args[3])\"}")
    exit(0)

case "headings":
    // Screen headings are static text, not controls; printing them is how a
    // recipe failure can be told apart from "the app ignored the press".
    guard args.count >= 3 else { fail("usage: macos-window headings <owner-substring>") }
    let app = runningApp(ownerContains: args[2])
    let window = firstWindow(app)
    var found: [(role: String, text: String)] = []
    collectText(window, into: &found)
    for entry in found {
        let escaped = entry.text.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: " ")
        print("{\"role\":\"\(entry.role)\",\"text\":\"\(escaped)\"}")
    }
    exit(0)

case "press-role":
    // The Settings tabs share labels with the sidebar ("Library"), so the role
    // has to be part of the match: AXRadioButton is the tab, AXButton the nav.
    guard args.count >= 5 else { fail("usage: macos-window press-role <owner> <role> <label>") }
    let app = runningApp(ownerContains: args[2])
    let window = firstWindow(app)
    var candidates: [AXUIElement] = []
    collectControls(window, label: args[4], into: &candidates)
    let wantedRole = "AX" + args[3]
    let matching = candidates.filter { (attribute($0, kAXRoleAttribute) as? String) == wantedRole }
    guard let target = matching.first else {
        fail("No \(wantedRole) labelled \"\(args[4])\"")
    }
    guard press(target) else { fail("Could not press the control") }
    print("{\"pressedRole\":\"\(args[3])\",\"label\":\"\(args[4])\"}")
    exit(0)

case "press-contains":
    // Album covers and other data-labelled cards have no stable prefix.
    guard args.count >= 4 else { fail("usage: macos-window press-contains <owner-substring> <substring>") }
    let app = runningApp(ownerContains: args[2])
    let window = firstWindow(app)
    var candidates: [AXUIElement] = []
    collectControls(window, label: args[3], into: &candidates)
    // Match `press`: among the controls containing the label, the shortest
    // text wins, so "Planet Walls 86 items" beats the sidebar's
    // "Sources 13 folders · 5,348 items" popup.
    var best: (length: Int, element: AXUIElement)?
    for candidate in candidates {
        for text in elementText(candidate) {
            if best == nil || text.count < best!.length {
                best = (text.count, candidate)
            }
        }
    }
    guard let target = best?.element else {
        fail("No control containing \"\(args[3])\"")
    }
    guard press(target) else { fail("Could not press the control") }
    print("{\"pressedContains\":\"\(args[3])\"}")
    exit(0)

case "radios":
    // Radio buttons report their state through AXValue, which is how the
    // original accent colour can be read back before a recipe changes it.
    guard args.count >= 3 else { fail("usage: macos-window radios <owner-substring>") }
    let app = runningApp(ownerContains: args[2])
    let window = firstWindow(app)
    var found: [(role: String, text: String)] = []
    collectLabels(window, into: &found)
    for entry in found where entry.role == kAXRadioButtonRole as String {
        let escaped = entry.text.replacingOccurrences(of: "\"", with: "\\\"")
        print("{\"text\":\"\(escaped)\"}")
    }
    exit(0)

case "has":
    guard args.count >= 4 else { fail("usage: macos-window has <owner-substring> <label-substring>") }
    let app = runningApp(ownerContains: args[2])
    let window = firstWindow(app)
    let found = findControl(window, label: args[3]) != nil
    jsonLine([("found", found)])
    exit(found ? 0 : 5)

case "fullscreen":
    guard args.count >= 4 else { fail("usage: macos-window fullscreen <owner-substring> <on|off>") }
    let app = runningApp(ownerContains: args[2])
    let window = firstWindow(app)
    let wanted = args[3] == "on"
    // In full-screen macOS hides the window from the Accessibility tree, so
    // the off case cannot set AXFullScreen. Toggle with the system shortcut
    // instead (Control-Command-F).
    if args[3] == "off" && window == nil {
        app.activate(options: [.activateAllWindows])
        usleep(400_000)
        let source = CGEventSource(stateID: .hidSystemState)
        let fKey: CGKeyCode = 3
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: fKey, keyDown: down) else {
                fail("could not build the full-screen toggle event")
            }
            event.flags = [.maskCommand, .maskControl]
            event.post(tap: .cghidEventTap)
            usleep(60_000)
        }
        usleep(1_200_000)
        print("{\"fullscreen\":false,\"method\":\"shortcut\"}")
        exit(0)
    }
    guard AXUIElementSetAttributeValue(
        window,
        "AXFullScreen" as CFString,
        (wanted ? kCFBooleanTrue : kCFBooleanFalse)
    ) == .success else {
        fail("Could not change the full-screen state")
    }
    // The transition animates; give it a moment before reading the state back.
    usleep(900_000)
    let actual = attribute(window, "AXFullScreen") as? Bool ?? false
    jsonLine([("fullscreen", actual), ("matched", actual == wanted)])
    exit(actual == wanted ? 0 : 4)

case "appearance":
    guard args.count >= 3 else { fail("usage: macos-window appearance <owner-substring> [light|dark|system]") }
    let app = runningApp(ownerContains: args[2])
    let window = firstWindow(app)
    // Views can still be settling when we ask; retry for a couple of seconds
    // before giving up so a slow transition does not look like a missing button.
    var start: String?
    for _ in 0..<20 {
        start = currentAppearance(window)
        if start != nil { break }
        usleep(100_000)
    }
    guard let start = start else {
        fail("Could not read the appearance button")
    }
    let target = args.count >= 4 ? args[3].capitalized : start
    var current = start
    // The button cycles light → dark → system → light, so three presses always
    // passes through every state.
    for _ in 0..<3 where current != target {
        guard let button = findControl(window, label: "Appearance:") else {
            fail("Appearance button disappeared while switching")
        }
        guard press(button) else { fail("Could not press the appearance button") }
        usleep(350_000)
        guard let next = currentAppearance(window) else { fail("Lost the appearance button") }
        current = next
    }
    jsonLine([("appearance", current), ("matched", current == target)])
    exit(current == target ? 0 : 4)

default:
    fail("unknown subcommand \(args[1])")
}
