import Foundation
import WebKit

// Compiles every converted content-rule list in a directory with the system's WebKit and reports
// the time and size of each, exiting non-zero if WebKit rejects one. macOS only: WebKit is the
// authority on what a list may contain, and a single bad rule fails the whole list on a device.
// Run with scripts/check-blocklists-webkit.sh.

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write(Data("usage: webkit-rule-check <rule-list-dir>\n".utf8))
  exit(2)
}
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let files =
  ((try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [])
  .filter { $0.pathExtension == "json" }
  .sorted { $0.lastPathComponent < $1.lastPathComponent }
if files.isEmpty {
  FileHandle.standardError.write(Data("no .json rule lists in \(directory.path)\n".utf8))
  exit(2)
}

let storeDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(
  "webkit-rule-check-\(UUID().uuidString)")
defer { try? FileManager.default.removeItem(at: storeDirectory) }

var failures = 0

func report(_ name: String, _ started: Date, _ size: Int, _ error: Error?) {
  let seconds = String(format: "%.1f", Date().timeIntervalSince(started))
  if let error {
    print("FAIL \(name): \(error)")
    failures += 1
  } else {
    print("ok   \(name): \(size / 1024) KB of JSON, compiled in \(seconds) s")
  }
}

Task { @MainActor in
  guard let store = WKContentRuleListStore(url: storeDirectory) else {
    print("FAIL cannot open a content rule list store")
    exit(1)
  }
  for file in files {
    let name = file.deletingPathExtension().lastPathComponent
    let started = Date()
    do {
      let json = try String(contentsOf: file, encoding: .utf8)
      _ = try await store.compileContentRuleList(forIdentifier: name, encodedContentRuleList: json)
      report(name, started, json.utf8.count, nil)
    } catch {
      report(name, started, 0, error)
    }
  }
  exit(failures == 0 ? 0 : 1)
}
RunLoop.main.run()
