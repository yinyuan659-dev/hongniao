import AVFoundation
import AVKit
import SwiftUI
import UniformTypeIdentifiers

/// POST /upload/file 的返回，原样作为 file 消息的 content
struct ChatFileResp: Codable {
    let url: String
    let name: String
    let size: Int
    let mime: String
}

/// 文件消息内容 { url, name, size, mime }；本地刚选、还没传完的没有 url
struct ChatFileInfo {
    var url: String?
    var name: String
    var size: Int
    var mime: String?
}

func parseChatFile(_ content: String) -> ChatFileInfo {
    let o = (try? JSONSerialization.jsonObject(with: Data(content.utf8))) as? [String: Any] ?? [:]
    let url = (o["url"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    let size = (o["size"] as? NSNumber)?.intValue ?? Int(o["size"] as? String ?? "") ?? 0
    return ChatFileInfo(url: url, name: o["name"] as? String ?? "", size: size, mime: o["mime"] as? String)
}

func chatFileContent(name: String, size: Int, mime: String, url: String? = nil) -> String {
    var o: [String: Any] = ["name": name, "size": size, "mime": mime]
    if let url { o["url"] = url }
    guard let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) else { return "{}" }
    return s
}

/// 按十进制算，和「100MB」上限的说法一致
func fmtFileSize(_ n: Int) -> String {
    let d = Double(n)
    if n < 1000 { return "\(n) B" }
    if n < 1_000_000 { return String(format: n < 10_000 ? "%.1f KB" : "%.0f KB", d / 1e3) }
    if n < 1_000_000_000 { return String(format: n < 10_000_000 ? "%.1f MB" : "%.0f MB", d / 1e6) }
    return String(format: "%.1f GB", d / 1e9)
}

/// 会话列表 / 引用条里的一行：label 是「[文件]」
func fileSnippet(_ content: String, label: String) -> String {
    let name = parseChatFile(content).name
    return name.isEmpty ? label : "\(label) \(name)"
}

/// 「文件」里选的按什么发
enum PickKind {
    case image, video, audio, file
}

/// 和后端 upload.service ALLOWED 一致，按扩展名认（UTType 给的 MIME 和后端认的不一定一样，如 wav）；图片发出前会转成 JPEG
private let imageExts: Set<String> = ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"]
private let videoMimes: [String: String] = ["mp4": "video/mp4", "mov": "video/quicktime"]
private let audioMimes: [String: String] = ["mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav"]
private let audioMax = 10 * 1024 * 1024

/// fileImporter 选的文件；copy 是拷到临时目录的副本（太大 / 空文件 / 读不了时为 nil，不拷）；duration 是音频秒数
struct PickedChatFile {
    let copy: URL?
    let name: String
    let size: Int
    let mime: String
    var kind: PickKind = .file
    var duration: Int = 0
}

/// 选中的 URL 只在安全作用域里能读，当场拷一份到临时目录，之后上传、重试都用副本；顺便定按什么发（音频读不出时长就按文件发）
func prepareChatFile(_ url: URL) -> PickedChatFile {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    let name = url.lastPathComponent
    let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    guard size > 0, size <= Api.fileMaxSize else { return PickedChatFile(copy: nil, name: name, size: size, mime: mime) }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("chatfile-\(UUID().uuidString)", isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent(name)
        try FileManager.default.copyItem(at: url, to: dest)
        let ext = dest.pathExtension.lowercased()
        if imageExts.contains(ext) {
            return PickedChatFile(copy: dest, name: name, size: size, mime: mime, kind: .image)
        }
        if let vm = videoMimes[ext] {
            return PickedChatFile(copy: dest, name: name, size: size, mime: vm, kind: .video)
        }
        if let am = audioMimes[ext], size <= audioMax {
            let secs = CMTimeGetSeconds(AVURLAsset(url: dest).duration)
            if secs.isFinite, secs > 0 {
                return PickedChatFile(copy: dest, name: name, size: size, mime: am, kind: .audio, duration: max(1, Int(secs.rounded())))
            }
        }
        return PickedChatFile(copy: dest, name: name, size: size, mime: mime)
    } catch {
        return PickedChatFile(copy: nil, name: name, size: size, mime: mime)
    }
}

/// 视频用系统播放器全屏放
enum VideoPlayback {
    @MainActor static func present(_ path: String) {
        guard let u = URL(string: Api.fullUrl(path)) else { return }
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        var top = scenes.flatMap { $0.windows }.first { $0.isKeyWindow }?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        guard let top else { return }
        let vc = AVPlayerViewController()
        vc.player = AVPlayer(url: u)
        top.present(vc, animated: true) { vc.player?.play() }
    }
}

/// 聊天里的视频：黑底 + 播放键，点了全屏播放；上传中盖进度，失败点了重试
struct ChatVideoTile: View {
    let url: String
    let state: UploadState?
    let sending: Bool
    var onRetry: () -> Void = {}

    var body: some View {
        let ready = !url.isEmpty && state == nil
        ZStack {
            Color(white: 0.07)
            if ready {
                Image(systemName: "play.circle.fill").font(.system(size: 44)).foregroundStyle(.white.opacity(0.85))
            }
        }
        .frame(width: 220, height: 140)
        .overlay(UploadOverlay(state: state, sending: sending, onRetry: onRetry))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .contentShape(Rectangle())
        .onTapGesture { if ready { VideoPlayback.present(url) } }
    }
}

/// 上传完删掉 prepareChatFile 拷的副本（连同它所在的临时目录）
func removeChatFileCopy(_ copy: URL) {
    try? FileManager.default.removeItem(at: copy.deletingLastPathComponent())
}

enum ChatFileOpener {
    /// 下载到临时目录（用原文件名），再弹系统分享面板：存到「文件」、用别的 App 打开、隔空投送
    @MainActor static func open(_ f: ChatFileInfo) async -> Bool {
        guard let path = f.url, let src = URL(string: Api.fullUrl(path)) else { return false }
        do {
            let (tmp, resp) = try await URLSession.shared.download(from: src)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { return false }
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("dl-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let clean = f.name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
            let dest = dir.appendingPathComponent(clean.isEmpty ? "file" : clean)
            try FileManager.default.moveItem(at: tmp, to: dest)
            ShareSheet.present([dest])
            return true
        } catch {
            return false
        }
    }
}

private let extColors: [(Set<String>, Color)] = [
    (["pdf"], Color(red: 0.90, green: 0.28, blue: 0.30)),
    (["doc", "docx", "pages", "rtf", "txt", "md"], Color(red: 0.18, green: 0.44, blue: 0.93)),
    (["xls", "xlsx", "csv", "numbers"], Color(red: 0.12, green: 0.62, blue: 0.33)),
    (["ppt", "pptx", "key"], Color(red: 0.91, green: 0.45, blue: 0.05)),
    (["zip", "rar", "7z", "gz", "tar", "bz2", "xz"], Color(red: 0.56, green: 0.42, blue: 0.85)),
    (["apk", "ipa", "exe", "dmg", "msi"], Color(red: 0.07, green: 0.66, blue: 0.66)),
    (["mp3", "m4a", "wav", "flac", "aac", "ogg", "mp4", "mov", "mkv", "avi", "webm"], Color(red: 0.84, green: 0.25, blue: 0.62)),
]

/// 文件气泡：上传中显示进度条，失败点了重试，传完点了下载再弹分享面板
struct FileBubbleView<S: Shape>: View {
    let f: ChatFileInfo
    let state: UploadState?
    let shape: S
    let bg: Color
    let onRetry: () -> Void
    @State private var downloading = false
    @State private var downloadFailed = false

    init(f: ChatFileInfo, state: UploadState?, shape: S, bg: Color, onRetry: @escaping () -> Void = {}) {
        self.f = f
        self.state = state
        self.shape = shape
        self.bg = bg
        self.onRetry = onRetry
    }

    private var ext: String {
        let e = (f.name as NSString).pathExtension.lowercased()
        return e.count <= 5 && e.allSatisfy { $0.isLetter || $0.isNumber } ? e : ""
    }

    private var color: Color {
        extColors.first { $0.0.contains(ext) }?.1 ?? Color(red: 0.42, green: 0.48, blue: 0.60)
    }

    var body: some View {
        let failed = state?.failed == true
        let p: Double? = failed ? nil : state?.progress
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(color)
                Text(ext.isEmpty ? "FILE" : ext.uppercased())
                    .font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                    .lineLimit(1).minimumScaleFactor(0.7).padding(.horizontal, 3)
            }
            .frame(width: 42, height: 42)
            VStack(alignment: .leading, spacing: 3) {
                Text(f.name.isEmpty ? t("chat.preview.file") : f.name)
                    .font(.system(size: 14)).foregroundStyle(Theme.text)
                    .lineLimit(2).truncationMode(.middle)
                Group {
                    if failed {
                        Text(t("chat.upload.retry")).foregroundStyle(Color.red)
                    } else if let p {
                        Text("\(fmtFileSize(Int(Double(f.size) * p))) / \(fmtFileSize(f.size))").foregroundStyle(Theme.textSub)
                    } else if downloading {
                        Text(t("chat.file.downloading")).foregroundStyle(Theme.textSub)
                    } else if downloadFailed {
                        Text(t("chat.file.downloadFailed")).foregroundStyle(Color.red)
                    } else {
                        Text(fmtFileSize(f.size)).foregroundStyle(Theme.textSub)
                    }
                }
                .font(.system(size: 12))
                if let p {
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.black.opacity(0.08))
                            Capsule().fill(Theme.accent).frame(width: g.size.width * min(max(p, 0), 1))
                        }
                    }
                    .frame(height: 3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(width: 236)
        .background(shape.fill(bg))
        .contentShape(Rectangle())
        .onTapGesture(perform: tap)
    }

    private func tap() {
        if state?.failed == true { onRetry(); return }
        guard state == nil, f.url != nil, !downloading else { return }
        downloading = true
        downloadFailed = false
        Task { @MainActor in
            let ok = await ChatFileOpener.open(f)
            downloading = false
            downloadFailed = !ok
        }
    }
}
