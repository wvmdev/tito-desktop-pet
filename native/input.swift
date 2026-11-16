// tito-input: posts mouse/keyboard events for Tito's computer-control tools.
// Needs the macOS Accessibility permission (granted to the app that launched Tito).
//
//   tito-input check                       -> {"trusted":true|false}
//   tito-input click X Y [left|right] [N]  -> click at global point (N = click count)
//   tito-input scroll X Y DX DY            -> scroll by pixels at point
//   tito-input key COMBO                   -> e.g. "cmd+shift+s", "return", "a"
//   tito-input type                        -> types UTF-8 text read from stdin (kept off argv)
// Exit codes: 0 ok, 2 not trusted, 64 bad usage.
import ApplicationServices
import CoreGraphics
import Foundation

let args = CommandLine.arguments
func fail(_ msg: String, _ code: Int32 = 64) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}
guard args.count >= 2 else { fail("usage") }

if args[1] == "check" {
  print("{\"trusted\":\(AXIsProcessTrusted())}")
  exit(0)
}
guard AXIsProcessTrusted() else { fail("not trusted", 2) }

let src = CGEventSource(stateID: .hidSystemState)
func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }

let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
  "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
  "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
  "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
  ".": 47, "`": 50,
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
  "forwarddelete": 117, "left": 123, "right": 124, "down": 125, "up": 126,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
  "f10": 109, "f11": 103, "f12": 111,
]
let modifiers: [String: CGEventFlags] = [
  "cmd": .maskCommand, "command": .maskCommand, "shift": .maskShift,
  "alt": .maskAlternate, "option": .maskAlternate, "ctrl": .maskControl, "control": .maskControl,
]

func num(_ i: Int) -> Double {
  guard args.count > i, let v = Double(args[i]) else { fail("bad number") }
  return v
}

switch args[1] {
case "click":
  let p = CGPoint(x: num(2), y: num(3))
  let right = args.count > 4 && args[4] == "right"
  let count = args.count > 5 ? max(1, min(3, Int(args[5]) ?? 1)) : 1
  let (down, up, btn): (CGEventType, CGEventType, CGMouseButton) =
    right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
  post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
  usleep(120_000)
  for n in 1...count {
    let d = CGEvent(mouseEventSource: src, mouseType: down, mouseCursorPosition: p, mouseButton: btn)
    d?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
    post(d)
    usleep(50_000)
    let u = CGEvent(mouseEventSource: src, mouseType: up, mouseCursorPosition: p, mouseButton: btn)
    u?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
    post(u)
    usleep(70_000)
  }

case "scroll":
  let p = CGPoint(x: num(2), y: num(3))
  post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
  usleep(80_000)
  post(CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2,
               wheel1: Int32(num(5)), wheel2: Int32(num(4)), wheel3: 0))

case "key":
  guard args.count > 2 else { fail("usage") }
  var flags: CGEventFlags = []
  var code: CGKeyCode? = nil
  for part in args[2].lowercased().split(separator: "+").map(String.init) {
    if let m = modifiers[part] { flags.insert(m) }
    else if let k = keyCodes[part] { code = k }
    else { fail("unknown key: \(part)") }
  }
  guard let kc = code else { fail("no key in combo") }
  let d = CGEvent(keyboardEventSource: src, virtualKey: kc, keyDown: true); d?.flags = flags; post(d)
  usleep(40_000)
  let u = CGEvent(keyboardEventSource: src, virtualKey: kc, keyDown: false); u?.flags = flags; post(u)

case "type":
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard let text = String(data: data, encoding: .utf8) else { fail("bad text") }
  for ch in text {
    if ch == "\n" {
      post(CGEvent(keyboardEventSource: src, virtualKey: 36, keyDown: true))
      post(CGEvent(keyboardEventSource: src, virtualKey: 36, keyDown: false))
    } else {
      let units = Array(String(ch).utf16)
      let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
      d?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      post(d)
      let u = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
      u?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      post(u)
    }
    usleep(8_000)
  }

default:
  fail("unknown command")
}
usleep(60_000)
