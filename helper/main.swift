// cc-helper — Mac-side sensors for Tab Command Center. Output is one line per event on stdout.
//
//   cc-helper events    front app, browser URL, idle seconds, keystrokes, CPU, battery (JSON lines; "k"/"c" for key/click)
//   cc-helper audio     system-audio spectrum via ScreenCaptureKit ("A<hex>" lines: level, beat, bands...)
//   cc-helper calendar  upcoming calendar events, one shot (JSON line)
//
// Privacy: keystrokes are reported only as "a key was pressed" — never which key.

import AppKit
import Accelerate
import CoreMedia
import EventKit
import Foundation
import IOKit.ps
import ScreenCaptureKit

let outLock = NSLock()

func emit(_ line: String) {
    outLock.lock()
    fputs(line + "\n", stdout)
    fflush(stdout)
    outLock.unlock()
}

func emitJSON(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let s = String(data: data, encoding: .utf8) else { return }
    emit(s)
}

// MARK: - Events

var keyTap: CFMachPort?

let tapCallback: CGEventTapCallBack = { _, type, event, _ in
    switch type {
    case .keyDown:
        if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 { emit("k") }
    case .leftMouseDown:
        emit("c")
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
        if let tap = keyTap { CGEvent.tapEnable(tap: tap, enable: true) }
    default:
        break
    }
    return Unmanaged.passUnretained(event)
}

final class Events: NSObject {
    // bundle id → AppleScript dialect for reading the active tab
    static let browsers: [String: String] = [
        "com.google.Chrome": "chromium", "com.google.Chrome.canary": "chromium",
        "com.brave.Browser": "chromium", "com.microsoft.edgemac": "chromium",
        "company.thebrowser.Browser": "chromium", "com.vivaldi.Vivaldi": "chromium",
        "com.apple.Safari": "safari",
    ]

    var scripts: [String: NSAppleScript] = [:]
    var front: NSRunningApplication?
    var lastURL = ""
    var urlFailing = false
    var reportedKeys: Bool?
    var askedKeys = false
    var prevBusy: UInt64 = 0
    var prevTotal: UInt64 = 0
    var lastBatt = ""

    func start() {
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(activated(_:)),
            name: NSWorkspace.didActivateApplicationNotification, object: nil)
        if let app = NSWorkspace.shared.frontmostApplication { setFront(app) }

        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [unowned self] _ in self.tickIdle() }
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [unowned self] _ in self.pollURL() }
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [unowned self] _ in self.tickCPU() }
        Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [unowned self] _ in self.tickBattery() }
        tickCPU()
        tickBattery()
        setupKeyTap()
    }

    @objc func activated(_ n: Notification) {
        if let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { setFront(app) }
    }

    func setFront(_ app: NSRunningApplication) {
        front = app
        lastURL = "\u{0}"
        pollURL()  // emit the URL first so the hub never flashes a generic "browser" scene
        emitJSON(["t": "app", "name": app.localizedName ?? "", "bundle": app.bundleIdentifier ?? ""])
    }

    func script(for bundle: String, dialect: String) -> NSAppleScript? {
        if let s = scripts[bundle] { return s }
        let tab = dialect == "safari" ? "current tab of front window" : "active tab of front window"
        let titleProp = dialect == "safari" ? "name" : "title"
        let src = """
        with timeout of 2 seconds
            tell application id "\(bundle)"
                if (count of windows) is 0 then return ""
                set t to \(tab)
                return (URL of t) & linefeed & (\(titleProp) of t)
            end tell
        end timeout
        """
        let s = NSAppleScript(source: src)
        scripts[bundle] = s
        return s
    }

    func pollURL() {
        guard let app = front, let bundle = app.bundleIdentifier,
              let dialect = Events.browsers[bundle], !app.isTerminated,
              let script = script(for: bundle, dialect: dialect) else { return }
        var err: NSDictionary?
        let res = script.executeAndReturnError(&err)
        if let err = err {
            if !urlFailing {
                urlFailing = true
                emitJSON(["t": "url", "bundle": bundle, "url": "", "title": "",
                          "err": "\(err[NSAppleScript.errorNumber] ?? "?")"])
                lastURL = ""
            }
            return
        }
        urlFailing = false
        let s = res.stringValue ?? ""
        if s == lastURL { return }
        lastURL = s
        let parts = s.components(separatedBy: "\n")
        emitJSON(["t": "url", "bundle": bundle, "url": parts.first ?? "",
                  "title": parts.dropFirst().joined(separator: " ")])
    }

    func tickIdle() {
        let anyInput = CGEventType(rawValue: ~0)!
        let s = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
        emitJSON(["t": "idle", "s": Int(s)])
    }

    func tickCPU() {
        var info = host_cpu_load_info()
        var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info_data_t>.size / MemoryLayout<integer_t>.size)
        let r = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &count)
            }
        }
        guard r == KERN_SUCCESS else { return }
        let user = UInt64(info.cpu_ticks.0), sys = UInt64(info.cpu_ticks.1)
        let idle = UInt64(info.cpu_ticks.2), nice = UInt64(info.cpu_ticks.3)
        let busy = user + sys + nice, total = busy + idle
        defer { prevBusy = busy; prevTotal = total }
        guard prevTotal > 0, total > prevTotal else { return }
        let pct = Double(busy - prevBusy) / Double(total - prevTotal) * 100
        emitJSON(["t": "cpu", "v": Int(pct.rounded())])
    }

    func tickBattery() {
        guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(blob)?.takeRetainedValue() as? [CFTypeRef] else { return }
        for src in list {
            guard let d = IOPSGetPowerSourceDescription(blob, src)?.takeUnretainedValue() as? [String: Any],
                  d[kIOPSTypeKey] as? String == kIOPSInternalBatteryType else { continue }
            let cur = d[kIOPSCurrentCapacityKey] as? Int ?? 0
            let max = d[kIOPSMaxCapacityKey] as? Int ?? 100
            let charging = d[kIOPSIsChargingKey] as? Bool ?? false
            let plugged = (d[kIOPSPowerSourceStateKey] as? String) == kIOPSACPowerValue
            let pct = max > 0 ? cur * 100 / max : cur
            let key = "\(pct)-\(charging)-\(plugged)"
            if key != lastBatt {
                lastBatt = key
                emitJSON(["t": "batt", "pct": pct, "charging": charging, "plugged": plugged])
            }
            return
        }
    }

    func setupKeyTap() {
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue) | CGEventMask(1 << CGEventType.leftMouseDown.rawValue)
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap,
                                          options: .listenOnly, eventsOfInterest: mask,
                                          callback: tapCallback, userInfo: nil) else {
            if reportedKeys != false { reportedKeys = false; emitJSON(["t": "keys", "ok": false]) }
            if !askedKeys { askedKeys = true; CGRequestListenEventAccess() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.setupKeyTap() }
            return
        }
        keyTap = tap
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        reportedKeys = true
        emitJSON(["t": "keys", "ok": true])
    }
}

// MARK: - Audio spectrum

final class AudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    static let n = 2048
    static let log2n = vDSP_Length(11)
    static let bands = 40

    let setup = vDSP_create_fftsetup(AudioCapture.log2n, FFTRadix(kFFTRadix2))!
    let window = vDSP.window(ofType: Float.self, usingSequence: .hanningDenormalized,
                             count: AudioCapture.n, isHalfWindow: false)
    var ring = [Float](repeating: 0, count: AudioCapture.n)
    var ringPos = 0
    var frame = [Float](repeating: 0, count: AudioCapture.n)
    var real = [Float](repeating: 0, count: AudioCapture.n / 2)
    var imag = [Float](repeating: 0, count: AudioCapture.n / 2)
    var mags = [Float](repeating: 0, count: AudioCapture.n / 2)
    var edges: [Int] = []
    var tilt: [Float] = []
    var bassBands = 4
    var sampleRate = 48000.0
    var sumSq: Float = 0
    var sumCount = 0
    var ceilDB: Float = 20
    var bassAvg: Float = -100
    var lastBeat = 0.0
    var lastSilentEmit = 0.0
    var stream: SCStream?

    override init() {
        super.init()
        computeBands()
    }

    func computeBands() {
        let fMin = 35.0, fMax = 16000.0
        let binHz = sampleRate / Double(AudioCapture.n)
        var e: [Int] = []
        var t: [Float] = []
        bassBands = 0
        for i in 0...AudioCapture.bands {
            let f = fMin * pow(fMax / fMin, Double(i) / Double(AudioCapture.bands))
            var bin = max(1, Int((f / binHz).rounded()))
            if let last = e.last, bin <= last { bin = last + 1 }
            e.append(min(bin, AudioCapture.n / 2))
            if i < AudioCapture.bands {
                let fc = fMin * pow(fMax / fMin, (Double(i) + 0.5) / Double(AudioCapture.bands))
                t.append(Float(4.0 * log2(fc / 200.0)))  // lift highs so the spectrum looks balanced
                if fc < 150 { bassBands += 1 }
            }
        }
        edges = e
        tilt = t
        bassBands = max(bassBands, 2)
    }

    func start() {
        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess()
            emitJSON(["t": "audio", "ok": false, "err": "Screen & System Audio Recording permission needed"])
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { exit(2) }
            return
        }
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first else { throw NSError(domain: "cc", code: 1) }
                let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                let cfg = SCStreamConfiguration()
                cfg.capturesAudio = true
                cfg.excludesCurrentProcessAudio = true
                cfg.sampleRate = 48000
                cfg.channelCount = 2
                cfg.width = 2
                cfg.height = 2
                cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                cfg.showsCursor = false
                let s = SCStream(filter: filter, configuration: cfg, delegate: self)
                try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "cc.audio", qos: .userInteractive))
                try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "cc.screen", qos: .background))
                try await s.startCapture()
                self.stream = s
                emitJSON(["t": "audio", "ok": true])
            } catch {
                emitJSON(["t": "audio", "ok": false, "err": error.localizedDescription])
                exit(3)
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emitJSON(["t": "audio", "ok": false, "err": error.localizedDescription])
        exit(4)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid,
              let asbd = sb.formatDescription?.audioStreamBasicDescription,
              asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 else { return }
        if asbd.mSampleRate != sampleRate {
            sampleRate = asbd.mSampleRate
            computeBands()
        }
        let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let channels = max(1, Int(asbd.mChannelsPerFrame))
        try? sb.withAudioBufferList { list, _ in
            if nonInterleaved {
                let chans = list.compactMap { $0.mData?.assumingMemoryBound(to: Float.self) }
                guard !chans.isEmpty else { return }
                let frames = Int(list[0].mDataByteSize) / 4
                let scale = 1 / Float(chans.count)
                for f in 0..<frames {
                    var s: Float = 0
                    for c in chans { s += c[f] }
                    push(s * scale)
                }
            } else if let p = list[0].mData?.assumingMemoryBound(to: Float.self) {
                let frames = Int(list[0].mDataByteSize) / 4 / channels
                let scale = 1 / Float(channels)
                for f in 0..<frames {
                    var s: Float = 0
                    for c in 0..<channels { s += p[f * channels + c] }
                    push(s * scale)
                }
            }
        }
        analyze()
    }

    @inline(__always) func push(_ s: Float) {
        ring[ringPos] = s
        ringPos = (ringPos + 1) & (AudioCapture.n - 1)
        sumSq += s * s
        sumCount += 1
    }

    func analyze() {
        let n = AudioCapture.n, half = n / 2
        let rms = sqrt(sumSq / Float(max(1, sumCount)))
        sumSq = 0
        sumCount = 0
        let rmsDB = 20 * log10(rms + 1e-9)
        let now = Date().timeIntervalSince1970
        var out = [UInt8](repeating: 0, count: AudioCapture.bands + 2)

        if rmsDB < -70 {
            // Silence: no need to spam the tablet at full rate.
            if now - lastSilentEmit > 0.25 { lastSilentEmit = now; emitHex(out) }
            return
        }

        for i in 0..<n { frame[i] = ring[(ringPos + i) & (n - 1)] * window[i] }
        frame.withUnsafeBufferPointer { fp in
            fp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) { cp in
                real.withUnsafeMutableBufferPointer { rp in
                    imag.withUnsafeMutableBufferPointer { ip in
                        var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                        vDSP_ctoz(cp, 2, &split, 1, vDSP_Length(half))
                        vDSP_fft_zrip(setup, &split, 1, AudioCapture.log2n, FFTDirection(kFFTDirection_Forward))
                        mags.withUnsafeMutableBufferPointer { mp in
                            vDSP_zvmags(&split, 1, mp.baseAddress!, 1, vDSP_Length(half))
                        }
                    }
                }
            }
        }

        var db = [Float](repeating: -200, count: AudioCapture.bands)
        var maxDB: Float = -200
        var bassPow: Float = 0
        for b in 0..<AudioCapture.bands {
            let lo = edges[b], hi = max(edges[b + 1], lo + 1)
            var sum: Float = 0
            for k in lo..<min(hi, half) { sum += mags[k] }
            let p = sum / Float(hi - lo)
            if b < bassBands { bassPow += p }
            db[b] = 10 * log10(p + 1e-12) + tilt[b]
            maxDB = max(maxDB, db[b])
        }

        // Auto-gain: jump up to new peaks instantly, relax slowly.
        ceilDB = maxDB > ceilDB ? maxDB : ceilDB - 0.12
        ceilDB = max(ceilDB, 15)
        let floorDB = ceilDB - 48
        for b in 0..<AudioCapture.bands {
            let v = min(1, max(0, (db[b] - floorDB) / (ceilDB - floorDB)))
            out[b + 2] = UInt8(pow(v, 1.5) * 255)
        }
        out[0] = UInt8(min(1, max(0, (rmsDB + 60) / 60)) * 255)

        // Beat: bass jumps well above its running average.
        let bassDB = 10 * log10(bassPow / Float(bassBands) + 1e-12)
        if bassDB > bassAvg + 4.5 && now - lastBeat > 0.25 && rmsDB > -45 {
            out[1] = 1
            lastBeat = now
        }
        bassAvg = bassAvg < -99 ? bassDB : bassAvg + (bassDB - bassAvg) * 0.08

        emitHex(out)
    }

    let hexDigits = Array("0123456789abcdef".utf8)

    func emitHex(_ bytes: [UInt8]) {
        var s = [UInt8](repeating: 0, count: bytes.count * 2 + 1)
        s[0] = UInt8(ascii: "A")
        for (i, b) in bytes.enumerated() {
            s[1 + i * 2] = hexDigits[Int(b >> 4)]
            s[2 + i * 2] = hexDigits[Int(b & 15)]
        }
        emit(String(decoding: s, as: UTF8.self))
    }
}

// MARK: - Calendar (one shot)

func runCalendar() {
    let store = EKEventStore()
    let finish: (Bool) -> Void = { granted in
        guard granted else {
            emitJSON(["t": "cal", "ok": false])
            exit(0)
        }
        let now = Date()
        let pred = store.predicateForEvents(withStart: now.addingTimeInterval(-6 * 3600),
                                            end: now.addingTimeInterval(36 * 3600), calendars: nil)
        let events = store.events(matching: pred)
            .filter { $0.endDate > now }
            .sorted { $0.startDate < $1.startDate }
            .prefix(6)
            .map { e -> [String: Any] in
                ["title": e.title ?? "", "start": Int(e.startDate.timeIntervalSince1970 * 1000),
                 "end": Int(e.endDate.timeIntervalSince1970 * 1000), "allDay": e.isAllDay,
                 "cal": e.calendar.title]
            }
        emitJSON(["t": "cal", "ok": true, "events": Array(events)])
        exit(0)
    }
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { granted, _ in finish(granted) }
    } else {
        store.requestAccess(to: .event) { granted, _ in finish(granted) }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
        emitJSON(["t": "cal", "ok": false, "err": "timeout"])
        exit(0)
    }
}

// MARK: - Main

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "events"
_ = NSApplication.shared
NSApp.setActivationPolicy(.prohibited)

var events: Events?
var audio: AudioCapture?

switch mode {
case "audio":
    audio = AudioCapture()
    audio?.start()
case "calendar":
    runCalendar()
case "events":
    events = Events()
    events?.start()
default:
    fputs("usage: cc-helper events|audio|calendar\n", stderr)
    exit(64)
}

RunLoop.main.run()
