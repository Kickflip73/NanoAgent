import Foundation
import ImageIO
import Vision

struct OCRFailure: Error, CustomStringConvertible {
    let description: String
}

func argument(_ index: Int, _ label: String) throws -> String {
    guard CommandLine.arguments.indices.contains(index) else {
        throw OCRFailure(description: "missing \(label)")
    }
    return CommandLine.arguments[index]
}

func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [])
    FileHandle.standardOutput.write(data)
}

do {
    let imagePath = try argument(1, "image path")
    guard let maxChars = Int(try argument(2, "max chars")), maxChars > 0 else {
        throw OCRFailure(description: "max chars must be positive")
    }
    guard let maxLines = Int(try argument(3, "max lines")), maxLines > 0 else {
        throw OCRFailure(description: "max lines must be positive")
    }
    let level = try argument(4, "recognition level")
    let languageArgument = try argument(5, "recognition languages")
    let languages = languageArgument.split(separator: ",").map(String.init).filter { !$0.isEmpty }

    let url = URL(fileURLWithPath: imagePath) as CFURL
    guard let source = CGImageSourceCreateWithURL(url, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw OCRFailure(description: "unable to decode image")
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = level == "fast" ? .fast : .accurate
    request.usesLanguageCorrection = true
    if !languages.isEmpty {
        request.recognitionLanguages = languages
    }
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    let observations = request.results ?? []
    var allText: [String] = []
    var lines: [[String: Any]] = []
    var lineCharacterBudget = maxChars
    var linesTruncated = false
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        allText.append(candidate.string)
        if lines.count < maxLines && lineCharacterBudget > 0 {
            let box = observation.boundingBox
            let lineText = String(candidate.string.prefix(lineCharacterBudget))
            if lineText.count < candidate.string.count { linesTruncated = true }
            lines.append([
                "text": lineText,
                "confidence": Double(candidate.confidence),
                "boundingBox": [
                    "x": Double(box.origin.x),
                    "y": Double(box.origin.y),
                    "width": Double(box.size.width),
                    "height": Double(box.size.height),
                ],
            ])
            lineCharacterBudget -= lineText.count
        } else {
            linesTruncated = true
        }
    }

    let completeText = allText.joined(separator: "\n")
    let boundedText = String(completeText.prefix(maxChars))
    try emit([
        "text": boundedText,
        "charCount": completeText.count,
        "truncated": completeText.count > maxChars,
        "lines": lines,
        "lineCount": allText.count,
        "linesTruncated": linesTruncated,
        "recognitionLevel": level,
        "recognitionLanguages": languages,
        "untrusted": true,
    ])
} catch {
    FileHandle.standardError.write(Data("macos screen OCR failed: \(error)\n".utf8))
    exit(1)
}
