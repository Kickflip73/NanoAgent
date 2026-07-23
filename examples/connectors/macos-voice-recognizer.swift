import AVFoundation
import Foundation
import Speech

struct VoiceFailure: Error, CustomStringConvertible {
    let description: String
}

final class RecognitionBox: @unchecked Sendable {
    private let lock = NSLock()
    private var signaled = false
    private(set) var text = ""
    private(set) var error: Error?
    let semaphore = DispatchSemaphore(value: 0)

    func update(result: SFSpeechRecognitionResult?, error: Error?) {
        lock.lock()
        defer { lock.unlock() }
        if let result { text = result.bestTranscription.formattedString }
        if let error { self.error = error }
        if (result?.isFinal == true || error != nil) && !signaled {
            signaled = true
            semaphore.signal()
        }
    }
}

func argument(_ index: Int, _ label: String) throws -> String {
    guard CommandLine.arguments.indices.contains(index) else {
        throw VoiceFailure(description: "missing \(label)")
    }
    return CommandLine.arguments[index]
}

func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func authorizeSpeech() throws {
    let status = SFSpeechRecognizer.authorizationStatus()
    if status == .authorized { return }
    if status == .denied || status == .restricted {
        throw VoiceFailure(description: "speech recognition permission denied")
    }
    let semaphore = DispatchSemaphore(value: 0)
    var resolved = status
    SFSpeechRecognizer.requestAuthorization { value in
        resolved = value
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + 30) == .timedOut {
        throw VoiceFailure(description: "speech recognition authorization timed out")
    }
    guard resolved == .authorized else {
        throw VoiceFailure(description: "speech recognition permission not authorized")
    }
}

func authorizeMicrophone() throws {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    if status == .authorized { return }
    if status == .denied || status == .restricted {
        throw VoiceFailure(description: "microphone permission denied")
    }
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { value in
        granted = value
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + 30) == .timedOut {
        throw VoiceFailure(description: "microphone authorization timed out")
    }
    if !granted { throw VoiceFailure(description: "microphone permission not authorized") }
}

func recognizer(locale: String) throws -> SFSpeechRecognizer {
    guard let value = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
        throw VoiceFailure(description: "unsupported speech locale: \(locale)")
    }
    return value
}

func configure(_ request: SFSpeechRecognitionRequest, onDevice: Bool, contextual: [String]) {
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = onDevice
    request.taskHint = .dictation
    request.contextualStrings = contextual
    request.addsPunctuation = true
}

func bounded(_ value: String, maxChars: Int) -> [String: Any] {
    let text = String(value.prefix(maxChars))
    return [
        "text": text,
        "charCount": value.count,
        "truncated": value.count > maxChars,
        "untrusted": true,
    ]
}

func transcribeFile(path: String, locale: String, onDevice: Bool, timeoutSeconds: Double, maxChars: Int, contextual: [String]) throws -> [String: Any] {
    try authorizeSpeech()
    let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
    configure(request, onDevice: onDevice, contextual: contextual)
    let box = RecognitionBox()
    let task = try recognizer(locale: locale).recognitionTask(with: request) { result, error in
        box.update(result: result, error: error)
    }
    if box.semaphore.wait(timeout: .now() + timeoutSeconds) == .timedOut {
        task.cancel()
        throw VoiceFailure(description: "audio transcription timed out")
    }
    task.cancel()
    if let error = box.error { throw error }
    return bounded(box.text, maxChars: maxChars)
}

func listenSegment(locale: String, onDevice: Bool, segmentSeconds: Double, maxChars: Int, contextual: [String]) throws -> [String: Any]? {
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    if format.sampleRate <= 0 || format.channelCount == 0 {
        throw VoiceFailure(description: "microphone has no usable audio format")
    }
    let request = SFSpeechAudioBufferRecognitionRequest()
    configure(request, onDevice: onDevice, contextual: contextual)
    let box = RecognitionBox()
    let task = try recognizer(locale: locale).recognitionTask(with: request) { result, error in
        box.update(result: result, error: error)
    }
    input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
        request.append(buffer)
    }
    defer {
        if engine.isRunning { engine.stop() }
        input.removeTap(onBus: 0)
        task.cancel()
    }
    engine.prepare()
    try engine.start()
    RunLoop.current.run(until: Date().addingTimeInterval(segmentSeconds))
    engine.stop()
    request.endAudio()
    _ = box.semaphore.wait(timeout: .now() + 5)
    if let error = box.error {
        let nsError = error as NSError
        if nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 1110 { return nil }
        throw error
    }
    let value = box.text.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.isEmpty { return nil }
    return bounded(value, maxChars: maxChars)
}

do {
    let mode = try argument(1, "mode")
    if mode == "transcribe" {
        let path = try argument(2, "audio path")
        let locale = try argument(3, "locale")
        let onDevice = try argument(4, "on-device flag") == "true"
        guard let timeout = Double(try argument(5, "timeout")), timeout > 0 else {
            throw VoiceFailure(description: "timeout must be positive")
        }
        guard let maxChars = Int(try argument(6, "max chars")), maxChars > 0 else {
            throw VoiceFailure(description: "max chars must be positive")
        }
        let contextual = try argument(7, "contextual strings").split(separator: "\u{1f}").map(String.init)
        var result = try transcribeFile(path: path, locale: locale, onDevice: onDevice, timeoutSeconds: timeout, maxChars: maxChars, contextual: contextual)
        result["locale"] = locale
        result["onDevice"] = onDevice
        try emit(result)
    } else if mode == "listen" {
        let locale = try argument(2, "locale")
        let onDevice = try argument(3, "on-device flag") == "true"
        guard let segmentSeconds = Double(try argument(4, "segment seconds")), segmentSeconds >= 2 else {
            throw VoiceFailure(description: "segment seconds must be at least 2")
        }
        guard let maxChars = Int(try argument(5, "max chars")), maxChars > 0 else {
            throw VoiceFailure(description: "max chars must be positive")
        }
        let contextual = try argument(6, "contextual strings").split(separator: "\u{1f}").map(String.init)
        try authorizeSpeech()
        try authorizeMicrophone()
        try emit(["type": "ready", "locale": locale, "onDevice": onDevice])
        while true {
            do {
                if var result = try listenSegment(locale: locale, onDevice: onDevice, segmentSeconds: segmentSeconds, maxChars: maxChars, contextual: contextual) {
                    result["type"] = "transcript"
                    result["locale"] = locale
                    result["onDevice"] = onDevice
                    try emit(result)
                }
            } catch {
                try emit(["type": "error", "error": String(describing: error)])
                Thread.sleep(forTimeInterval: 1)
            }
        }
    } else {
        throw VoiceFailure(description: "unsupported mode: \(mode)")
    }
} catch {
    FileHandle.standardError.write(Data("macos voice recognition failed: \(error)\n".utf8))
    exit(1)
}
