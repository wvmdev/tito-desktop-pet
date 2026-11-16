// tito-windows: streams the on-screen app windows (front-to-back) as one JSON array per line.
// Bounds only — no titles or contents — so it needs no Screen Recording permission.
// Usage: tito-windows <ownPid> [intervalMs]
import CoreGraphics
import Foundation

let args = CommandLine.arguments
let ownPid = args.count > 1 ? Int(args[1]) ?? 0 : 0
let interval = (args.count > 2 ? Double(args[2]) ?? 250 : 250) / 1000.0
let parent = getppid()
setvbuf(stdout, nil, _IOLBF, 0)

while true {
  if getppid() != parent { exit(0) } // Tito quit: don't linger
  var out: [[String: Any]] = []
  let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  if let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
    for w in list {
      guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
            let pid = w[kCGWindowOwnerPID as String] as? Int, pid != ownPid,
            let b = w[kCGWindowBounds as String] as? [String: Any],
            let x = b["X"] as? Double, let y = b["Y"] as? Double,
            let ww = b["Width"] as? Double, let hh = b["Height"] as? Double else { continue }
      let alpha = w[kCGWindowAlpha as String] as? Double ?? 1
      if alpha < 0.2 || ww < 120 || hh < 60 { continue }
      let id = w[kCGWindowNumber as String] as? Int ?? 0
      out.append(["id": id, "pid": pid, "x": x, "y": y, "w": ww, "h": hh])
    }
  }
  if let data = try? JSONSerialization.data(withJSONObject: out),
     let s = String(data: data, encoding: .utf8) { print(s) }
  Thread.sleep(forTimeInterval: interval)
}
