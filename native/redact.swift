// tito-redact: blacks out secret-looking text in a screenshot before it is sent anywhere.
// Runs Apple's on-device text recognition (Vision), matches each recognised line against the
// regular expressions given on stdin (a JSON array of patterns), and paints a black box over
// every match. Nothing leaves the Mac.
//
//   tito-redact <in image> <out.jpg>   (stdin: ["pattern", ...])  -> {"redacted": N}
import AppKit
import Foundation
import Vision

let args = CommandLine.arguments
func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}
guard args.count == 4 || args.count == 3 else { fail("usage: tito-redact in out") }
guard let image = NSImage(contentsOfFile: args[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fail("cannot read image") }

let stdinData = FileHandle.standardInput.readDataToEndOfFile()
let patternStrings = (try? JSONSerialization.jsonObject(with: stdinData)) as? [String] ?? []
let patterns = patternStrings.compactMap { try? NSRegularExpression(pattern: $0, options: []) }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false // keys are not words; don't "correct" them
do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request]) } catch { fail("ocr failed") }

let w = CGFloat(cg.width), h = CGFloat(cg.height)
var boxes: [CGRect] = []
for obs in request.results ?? [] {
  guard let cand = obs.topCandidates(1).first else { continue }
  let text = cand.string
  let ns = text as NSString
  for re in patterns {
    for m in re.matches(in: text, options: [], range: NSRange(location: 0, length: ns.length)) {
      // Redact capture group 1 when the pattern has one (e.g. the value after "password:").
      let r = m.numberOfRanges > 1 && m.range(at: 1).location != NSNotFound ? m.range(at: 1) : m.range
      var rect = obs.boundingBox
      if let sr = Range(r, in: text), let b = try? cand.boundingBox(for: sr) { rect = b.boundingBox }
      // Vision uses a bottom-left origin in 0..1; CoreGraphics bitmap contexts do too.
      boxes.append(CGRect(x: rect.minX * w, y: rect.minY * h, width: rect.width * w, height: rect.height * h)
        .insetBy(dx: -4, dy: -3))
    }
  }
}

guard let ctx = CGContext(data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: 0,
                          space: CGColorSpaceCreateDeviceRGB(),
                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fail("no context") }
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
for b in boxes { ctx.fill(b) }
guard let out = ctx.makeImage() else { fail("no image") }
let rep = NSBitmapImageRep(cgImage: out)
guard let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else { fail("encode failed") }
do { try jpg.write(to: URL(fileURLWithPath: args[2])) } catch { fail("write failed") }
print("{\"redacted\":\(boxes.count)}")
