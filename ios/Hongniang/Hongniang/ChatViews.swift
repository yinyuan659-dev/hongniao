import SwiftUI
import Photos
import PhotosUI
import UniformTypeIdentifiers
import AVFoundation
import Combine
import WebKit
import CoreImage

struct PeerBrief: Codable, Hashable {
    var id: String = ""
    var nickname: String? = ""
    var avatar: String? = ""
    var gender: Int? = 0
}

struct LastMsg: Codable, Hashable {
    var id: String = ""
    var senderId: String? = ""
    var type: String? = ""
    var content: String? = ""
    var createdAt: String? = ""
}

struct ConversationItem: Codable, Identifiable, Hashable {
    var id: String = ""
    var type: Int = 1
    var peer: PeerBrief? = nil
    var lastMsg: LastMsg? = nil
    var unread: Int? = 0
    var lastMsgAt: String? = ""
    /// 互相喜欢的才有：fresh = 刚配上还没说过话
    var match: ConvMatch? = nil
    /// 对方点了「不合适，不再联系」
    var ended: Bool? = false
}

struct ConvMatch: Codable, Hashable {
    var at: String? = nil
    var fresh: Bool? = false
}

struct MsgItem: Codable, Identifiable {
    var id: String = ""
    var conversationId: String = ""
    var senderId: String = ""
    var senderNickname: String? = ""
    var senderAvatar: String? = ""
    var receiverId: String? = nil
    var type: String = "text"
    var content: String = ""
    var createdAt: String? = ""
    var isRead: Bool? = nil
    var replyTo: ReplyPreview? = nil
    var fwdFrom: String? = nil
    var reactions: [MsgReaction]? = nil
    /// 本地刚选的图：上传任务的 key（预览图、进度、失败重试按它找）
    var upKey: String? = nil

    var pending: Bool { id.hasPrefix("t_") || id.hasPrefix("local_") }
}

func previewOf(_ msg: LastMsg?) -> String {
    guard let msg, let type = msg.type else { return "" }
    switch type {
    case "text": return String((msg.content ?? "").prefix(30))
    case "image": return t("chat.preview.image")
    case "video": return t("chat.preview.video")
    case "audio": return t("chat.preview.voice")
    case "file": return fileSnippet(msg.content ?? "", label: t("chat.preview.file"))
    case "location": return t("chat.preview.location")
    default: return type.hasPrefix("call") ? t("chat.preview.call") : ""
    }
}

/// 消息主页：标题 + 搜索 + 会话列表（会话按最新时间排）
struct MessagesView: View {
    @State private var convs: [ConversationItem] = []
    @State private var chatTarget: ChatTarget?
    @State private var pushRoute: Route?
    @State private var removeListener: (() -> Void)?
    @State private var showSearch = false
    @State private var showScan = false
    /// 顶上三个数字：喜欢我的 / 我喜欢的 / 互相喜欢
    @State private var likeSum: MatchSummary?
    @ObservedObject private var matchCenter = MatchCenter.shared

    private var entries: [ConversationItem] {
        convs.sorted { (parseIsoDate($0.lastMsgAt) ?? .distantPast) > (parseIsoDate($1.lastMsgAt) ?? .distantPast) }
    }

    var body: some View {
        ZStack {
            NavStack {
                VStack(spacing: 0) {
                    header
                    searchPill
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            // 喜欢我的 / 我喜欢的 / 互相喜欢：点开是喜欢列表（网页）
                            LikeEntriesView(sum: likeSum)
                            ForEach(entries) { convRow($0) }
                            if entries.isEmpty {
                                Text("还没有聊天。\n互相喜欢以后，对方会出现在这里。").font(.subheadline).foregroundStyle(Theme.textSub)
                                    .multilineTextAlignment(.center).lineSpacing(8)
                                    .padding(.vertical, 60)
                            }
                        }
                    }
                }
                .fullBg()
                .withRoutes()
                .routePush($pushRoute)
                .scanFlow(isPresented: $showScan)
                // 从喜欢列表（网页）回来：数字和列表重新取
                .onAppear { Task { await loadConvs() } }
            }
            if showSearch {
                ChatSearchView(
                    convs: convs,
                    extras: [],
                    onClose: { showSearch = false },
                    onOpenChat: { t in
                        showSearch = false
                        chatTarget = t
                    },
                    onOpenUser: { id, name in
                        showSearch = false
                        // 搜到的人：互相喜欢了才能直接聊，不能聊的打开 TA 的画像（在那里点喜欢）
                        Task {
                            if let t = await openChatIfAllowed(userId: id, nickname: name) { chatTarget = t } else { pushRoute = .userHome(id) }
                        }
                    },
                    onScan: { showSearch = false; showScan = true }
                )
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.18), value: showSearch)
        .fullScreenCover(item: $chatTarget) { t in
            ChatRoomSheet(target: t)
        }
        .task {
            await loadConvs()
            WsClient.shared.connect()
            removeListener = WsClient.shared.addListener { frame in
                let op = frame["op"] as? String
                if op == "msg" || op == "conv_cleared" || op == "conv_refresh" { Task { await loadConvs() } }
            }
        }
        .onDisappear { removeListener?() }
        // 有人喜欢了我 / 互相喜欢了 / 对方结束了聊天：数字和列表都重新取
        .onChange(of: matchCenter.version) { _ in Task { await loadConvs() } }
    }

    private var header: some View {
        HStack {
            Text(t("tab.messages")).font(.system(size: 22, weight: .bold)).foregroundStyle(Theme.text)
            Spacer()
        }
        .padding(EdgeInsets(top: 12, leading: 16, bottom: 8, trailing: 16))
    }

    /// 搜索胶囊：点了弹全屏搜索框
    private var searchPill: some View {
        Button { showSearch = true } label: {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 15, weight: .medium))
                Text(t("common.search")).font(.system(size: 15))
            }
            .foregroundStyle(Theme.textSub)
            .frame(maxWidth: .infinity)
            .frame(height: 36)
            .background(Capsule().fill(Theme.bg3))
        }
        .buttonStyle(.plain)
        // 右端扫一扫（邀请名片 → 私聊）
        .overlay(alignment: .trailing) {
            Button { showScan = true } label: {
                Image(systemName: "qrcode.viewfinder").font(.system(size: 16)).foregroundStyle(Theme.textSub)
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .padding(.trailing, 2)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
    }

    /// 消息列表一行：左图标 54 + 标题 / 时间 + 预览 / 角标，分隔线和文字对齐
    private func listRow<Leading: View, Title: View>(
        time: String, sub: String, badge: Int, pinned: Bool = false,
        @ViewBuilder leading: () -> Leading, @ViewBuilder title: () -> Title
    ) -> some View {
        HStack(spacing: 12) {
            leading()
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        title()
                        Spacer(minLength: 8)
                        if !time.isEmpty { Text(time).font(.system(size: 11)).foregroundStyle(Theme.textDim) }
                    }
                    HStack(spacing: 8) {
                        Text(sub).font(.system(size: 14)).foregroundStyle(Theme.textSub).lineLimit(1)
                        Spacer(minLength: 0)
                        if badge > 0 {
                            Text(badge > 99 ? "99+" : "\(badge)").font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                                .padding(.horizontal, 6).frame(minWidth: 20, minHeight: 20)
                                .background(Capsule().fill(Theme.accent))
                        }
                        if pinned {
                            Image(systemName: "pin.fill").font(.system(size: 11)).foregroundStyle(Theme.textDim).rotationEffect(.degrees(45))
                        }
                    }
                }
                .frame(maxHeight: .infinity)
                .padding(.trailing, 16)
                Rectangle().fill(Theme.line).frame(height: 1)
            }
        }
        .padding(.leading, 16)
        .frame(height: 72)
        .contentShape(Rectangle())
    }

    private func convRow(_ c: ConversationItem) -> some View {
        let name = c.peer?.nickname ?? ""
        let avatar = c.peer?.avatar
        let target = c.peer?.id ?? ""
        // 刚互相喜欢、还没说过话
        let fresh = c.match?.fresh == true
        let sub = fresh ? "你们互相喜欢了，打个招呼吧" : (c.ended == true && c.lastMsg == nil ? "对方已结束聊天" : previewOf(c.lastMsg))
        return Button {
            chatTarget = ChatTarget(convId: c.id, convType: c.type, targetId: target, title: name)
        } label: {
            listRow(time: fmtTime(c.lastMsgAt), sub: sub, badge: c.unread ?? 0) {
                AvatarView(url: avatar, size: 54)
            } title: {
                Text(name).font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.text).lineLimit(1)
                if fresh {
                    Text("刚配上").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(HnTheme.rose).lineLimit(1).fixedSize()
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(Capsule().fill(HnTheme.soft))
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func loadConvs() async {
        convs = (try? await Api.request("/im/conversations")) ?? convs
        if let s: MatchSummary = try? await Api.request("/match/summary") { likeSum = s }
    }
}

/// 聊天全屏容器（fullScreenCover 用，带关闭按钮）
struct ChatRoomSheet: View {
    let target: ChatTarget
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavStack {
            ChatRoomView(convId: target.convId, convType: target.convType, targetId: target.targetId, title: target.title, focusMsgId: target.focusMsgId, draft: target.draft)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button { dismiss() } label: {
                            Image(systemName: "chevron.left").foregroundStyle(Theme.text)
                        }
                    }
                }
        }
    }
}

/// WS 帧里的 id 可能是字符串也可能是数字
private func frameStr(_ v: Any?) -> String? {
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

/// 语音播放器（保持引用）
final class AudioPlayerBox {
    static let shared = AudioPlayerBox()
    var player: AVPlayer?
    private var endObserver: NSObjectProtocol?
    private var onFinish: (() -> Void)?

    func play(_ url: String, onFinish: (() -> Void)? = nil) {
        guard let u = URL(string: Api.fullUrl(url)) else { onFinish?(); return }
        // 切换到新语音时，先通知上一个气泡停止动画
        self.onFinish?()
        if let o = endObserver { NotificationCenter.default.removeObserver(o) }
        self.onFinish = onFinish

        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        player = AVPlayer(url: u)
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: player?.currentItem,
            queue: .main
        ) { [weak self] _ in
            self?.onFinish?()
            self?.onFinish = nil
        }
        player?.play()
    }
}

/// 录音器
final class VoiceRecorder {
    private var recorder: AVAudioRecorder?
    private var startAt = Date()
    private(set) var fileUrl: URL?

    func start() {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            guard granted else { return }
            DispatchQueue.main.async { [weak self] in self?.beginRecord() }
        }
    }

    private func beginRecord() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .default)
        try? session.setActive(true)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("rec_\(Int(Date().timeIntervalSince1970)).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        recorder = try? AVAudioRecorder(url: url, settings: settings)
        recorder?.isMeteringEnabled = true
        recorder?.record()
        fileUrl = url
        startAt = Date()
    }

    /// 当前录音音量 0~1，驱动录音动画
    func level() -> CGFloat {
        guard let r = recorder else { return 0 }
        r.updateMeters()
        let db = r.averagePower(forChannel: 0) // -160(静音) ~ 0(最大)
        return CGFloat(max(0, min(1, (db + 50) / 50)))
    }

    var durationSeconds: Int { recorder == nil ? 0 : Int(Date().timeIntervalSince(startAt)) }

    /// 返回 (data, durationSec)；太短返回 nil
    func stop() -> (Data, Int)? {
        recorder?.stop()
        recorder = nil
        let dur = max(1, Int(Date().timeIntervalSince(startAt)))
        guard let url = fileUrl, let data = try? Data(contentsOf: url), data.count > 200 else { return nil }
        return (data, dur)
    }
}

/// 录音中悬浮提示：实时音量波形 + 计时（微信式），避免看起来像卡死
struct RecordingOverlay: View {
    let recorder: VoiceRecorder
    @State private var levels: [CGFloat] = Array(repeating: 0, count: 24)
    @State private var seconds = 0
    private let timer = Timer.publish(every: 0.08, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 12) {
            HStack(alignment: .center, spacing: 3) {
                ForEach(levels.indices, id: \.self) { i in
                    Capsule()
                        .fill(.white)
                        .frame(width: 3, height: 5 + levels[i] * 30)
                }
            }
            .frame(height: 40)
            .animation(.linear(duration: 0.08), value: levels)

            Text(String(format: "%d:%02d", seconds / 60, seconds % 60))
                .font(.system(size: 14, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(.white)

            Text(t("chat.releaseToSend"))
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.75))
        }
        .padding(.horizontal, 30).padding(.vertical, 22)
        .background(RoundedRectangle(cornerRadius: 18).fill(Theme.accent.opacity(0.95)))
        .shadow(color: .black.opacity(0.35), radius: 18, y: 6)
        .onReceive(timer) { _ in
            levels.removeFirst()
            levels.append(recorder.level())
            seconds = recorder.durationSeconds
        }
    }
}

/// 聊天页：文字 / 图片 / 语音 / 位置 / 通话
struct ChatRoomView: View {
    let convId: String
    let convType: Int
    let targetId: String
    let title: String
    var focusMsgId: String? = nil
    /// 先填进输入框的话（从互相喜欢的庆祝页点了一句开场白进来），可以改了再发
    var draft: String? = nil

    @EnvironmentObject var state: AppState
    @ObservedObject private var matchCenter = MatchCenter.shared
    @Environment(\.dismiss) private var dismissChat
    /// 我和对方的关系：互相喜欢了才能发消息（规则上线前就聊过的有保留期）
    @State private var rel: MatchRelation?
    @State private var showReportUser = false
    @State private var showEndConfirm = false
    @State private var draftUsed = false
    @State private var messages: [MsgItem] = []
    // 从搜索结果进来：首屏定位到该消息并闪一下，之后照常滚到底
    @State private var focusPending = true
    @State private var flashId: String?
    @State private var input = ""
    @State private var voiceMode = false
    @State private var recording = false
    @State private var showAttach = false
    @State private var showEmoji = false
    @State private var fullImage: String?
    @State private var removeListener: (() -> Void)?
    @State private var toastMsg: String?
    @State private var showClearConfirm = false
    /// 没完成资料收集就发消息：弹框带去 AI 红娘
    @State private var needProfile = false
    /// 后台要求先做实人认证、没做就发消息被拒
    @State private var needKyc = false
    @State private var pushRoute: Route?
    private let recorderBox = VoiceRecorder()
    @FocusState private var inputFocused: Bool
    // 长按菜单及其衍生操作
    @State private var menuMsg: MsgItem?
    @State private var replyTo: MsgItem?
    @State private var pins: [PinItem] = []
    @State private var pinIdx = 0
    @State private var selecting: Set<String>?
    @State private var deleteIds: [String]?
    @State private var forwardIds: IdList?
    @State private var reportId: String?
    @State private var jumpReq: String?
    @State private var scannedQr: String?
    // 发图：本地预览、上传进度 / 失败、待传的原图（按 upKey）
    @State private var localImages: [String: UIImage] = [:]
    @State private var uploads: [String: UploadState] = [:]
    @State private var upSources: [String: UploadSource] = [:]
    /// 「文件」里选的视频 / 文件（按 upKey）：副本在临时目录，传完删掉
    @State private var upPicked: [String: PickedChatFile] = [:]
    @State private var showFilePicker = false

    private var myId: String { state.user?.id ?? "" }
    private var rows: [ChatRow] { groupAlbums(messages) }

    /// 滚动定位用的行 id（相册按第一张）
    private func anchorId(_ id: String) -> String {
        rows.first(where: { r in r.items.contains(where: { $0.id == id }) })?.first.id ?? id
    }
    private var canPin: Bool { convType == 1 }

    // body 拆成几段，整块写在一起 Swift 类型检查会超时
    var body: some View {
        matchDecorated(decorated(msgActionLayers(mainColumn)))
            .task { await onLoad() }
            .onDisappear { removeListener?() }
            .scanHandler($scannedQr)
    }

    private var mainColumn: some View {
        VStack(spacing: 0) {
            pinBarView
            // 顶上一条提示：哪天配上的 + 防骗提醒
            ChatMatchBanner(rel: rel)
            ScrollViewReader { proxy in messageScroll(proxy) }
            bottomArea
        }
    }

    /// 取我和对方的关系：进来取一次；互相喜欢了 / 对方结束了聊天、从对方的画像网页回来，都重新取
    private func loadRel() async {
        guard !targetId.isEmpty else { return }
        if let r: MatchRelation = try? await Api.request("/match/relation/\(targetId)") { rel = r }
    }

    /// 喜欢相关的几样：关系刷新、举报、不合适不再联系
    private func matchDecorated<V: View>(_ v: V) -> some View {
        v
        .onAppear {
            if !draftUsed, let d = draft, !d.isEmpty, input.isEmpty { input = d }
            draftUsed = true
            Task { await loadRel() }
        }
        .onChange(of: matchCenter.version) { _ in Task { await loadRel() } }
        .confirmationDialog("举报的原因（对方不会知道是你举报的）", isPresented: $showReportUser, titleVisibility: .visible) {
            ForEach(reportUserReasons, id: \.self) { reason in
                Button(reason) { Task { toastMsg = await reportUser(targetId, reason: reason) } }
            }
            Button(t("common.cancel"), role: .cancel) {}
        }
        .alert("不合适，不再联系", isPresented: $showEndConfirm) {
            Button("不再联系", role: .destructive) { endChat() }
            Button(t("common.cancel"), role: .cancel) {}
        } message: {
            Text("之后你们都不能再给对方发消息，这个聊天会从列表里收起，也不再互相推荐。对方只会看到「对方已结束聊天」。")
        }
    }

    private func endChat() {
        Task {
            do {
                let _: MatchOk = try await Api.request("/match/end/\(targetId)", method: "POST")
                MatchCenter.shared.version += 1
                dismissChat()
            } catch {
                toastMsg = (error as? ApiError)?.msg ?? t("chat.sendFailed")
            }
        }
    }

    /// 聊天页右上角能不能点「不合适，不再联系」：互相喜欢的、老聊天、对方已经结束的
    private var canEnd: Bool {
        guard let r = rel, r.endedBy != "me" else { return false }
        return r.state == "mutual" || (r.chatReason ?? "").hasPrefix("legacy") || r.endedBy == "peer"
    }

    @ViewBuilder
    private var pinBarView: some View {
        if !pins.isEmpty && selecting == nil {
            PinBar(pins: pins, index: pinIdx, canUnpin: canPin, onJump: {
                let p = pins[pinIdx % pins.count]
                pinIdx += 1
                jumpTo(p.id)
            }, onUnpin: {
                togglePin(pins[pinIdx % pins.count].id, pin: false)
            })
        }
    }

    private var messageStack: some View {
        LazyVStack(spacing: 0) {
            ForEach(rows) { row in
                rowView(row)
            }
            Color.clear.frame(height: 1).id(Self.bottomId)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private static let bottomId = "chat-bottom"

    /// 一行：时间分隔条（与上一条间隔超 5 分钟）+ 气泡（相册一行多张）
    private func rowView(_ row: ChatRow) -> some View {
        let m = row.first
        let ids = row.items.map(\.id)
        let flashOn = flashId.map { ids.contains($0) } ?? false
        return VStack(spacing: 0) {
            if shouldShowTime(row.start) {
                Text(fmtTime(m.createdAt))
                    .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            messageRow(row)
                .background(RoundedRectangle(cornerRadius: 8).fill(flashOn ? Theme.accent.opacity(0.14) : Color.clear))
        }
        .id(m.id)
    }

    /// 滚到底。LazyVStack 里没量过的行只是估算高度，图片 / 卡片随后才撑开，滚一次常常停在半路：
    /// 刚进聊天时隔几下再滚，直到布局稳定
    private func scrollToBottom(_ proxy: ScrollViewProxy, settle: Bool) {
        let delays: [Double] = settle ? [0, 0.12, 0.3, 0.6, 1.0] : [0, 0.15]
        for d in delays {
            DispatchQueue.main.asyncAfter(deadline: .now() + d) { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
        }
    }

    private func messageScroll(_ proxy: ScrollViewProxy) -> some View {
        ScrollView { messageStack }
        .simultaneousGesture(TapGesture().onEnded { showEmoji = false; inputFocused = false })
        .inAppLinks()
        .onChange(of: jumpReq) { id in
            guard let id else { return }
            jumpReq = nil
            let anchor = anchorId(id)
            DispatchQueue.main.async { withAnimation { proxy.scrollTo(anchor, anchor: .center) } }
            withAnimation(.easeOut(duration: 0.15)) { flashId = id }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                withAnimation(.easeOut(duration: 0.9)) { if flashId == id { flashId = nil } }
            }
        }
        // 进入聊天默认停在最底部（最新消息）；defaultScrollAnchor 是 iOS 17 API，改用 scrollTo
        .onAppear {
            if !messages.isEmpty { scrollToBottom(proxy, settle: true) }
        }
        .onChange(of: messages.count) { _ in
            var first = false
            if focusPending, !messages.isEmpty {
                focusPending = false
                first = true
                if let fid = focusMsgId, messages.contains(where: { $0.id == fid }) {
                    let anchor = anchorId(fid)
                    DispatchQueue.main.async { proxy.scrollTo(anchor, anchor: .center) }
                    withAnimation(.easeOut(duration: 0.15)) { flashId = fid }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                        withAnimation(.easeOut(duration: 0.9)) { flashId = nil }
                    }
                    return
                }
            }
            if !messages.isEmpty { scrollToBottom(proxy, settle: first) }
        }
        .onChange(of: inputFocused) { focused in
            if focused {
                // 键盘弹出时收起表情面板，避免两者叠加把内容顶飞
                showEmoji = false
                if !messages.isEmpty {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        withAnimation { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var bottomArea: some View {
        if let sel = selecting {
            selectBar(sel)
        } else if let r = rel, r.canChat == false {
            // 不能发消息：输入区换成一句说明，聊天记录照常能看
            ChatBlockedBar(rel: r) { pushRoute = .userHome(targetId) }
        } else {
            bottomBar
        }
    }

    private func navDecorated<V: View>(_ v: V) -> some View {
        v.overlay {
            if recording {
                RecordingOverlay(recorder: recorderBox)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
            }
        }
        .animation(.easeOut(duration: 0.15), value: recording)
        .fullBg()
        .toast($toastMsg)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toolbar { toolbarItems }
    }

    @ToolbarContentBuilder
    private var toolbarItems: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
        }
        ToolbarItem(placement: .navigationBarTrailing) {
            Menu {
                if !targetId.isEmpty {
                    Button { pushRoute = .userHome(targetId) } label: { Label("看 TA 的画像", systemImage: "person.crop.rectangle") }
                    // 视频见面：能聊天、并且两个人都打开了视频见面开关才打得通（没打开服务器会给出提示）
                    if rel?.canChat == true {
                        Button {
                            let peerAvatar = messages.first(where: { $0.senderId == targetId })?.senderAvatar ?? ""
                            startCallWithPermissions(calleeId: targetId, type: 2, name: title, avatar: peerAvatar)
                        } label: { Label("视频见面", systemImage: "video") }
                    }
                    Button { showReportUser = true } label: { Label("举报", systemImage: "exclamationmark.bubble") }
                    if canEnd {
                        Button(role: .destructive) { showEndConfirm = true } label: { Label("不合适，不再联系", systemImage: "hand.raised") }
                    }
                }
                Button(role: .destructive) {
                    showClearConfirm = true
                } label: {
                    Label(t("chat.menu.clear"), systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.text)
                    .frame(width: 32, height: 32)
            }
        }
    }

    private func decorated<V: View>(_ v: V) -> some View {
        navDecorated(v)
        .confirmationDialog(
            t("chat.clearSingleConfirm"),
            isPresented: $showClearConfirm,
            titleVisibility: .visible
        ) {
            Button(t("chat.menu.clear"), role: .destructive) { clearChat() }
            Button(t("common.cancel"), role: .cancel) {}
        }
        .alert(t("hn.needTitle"), isPresented: $needProfile) {
            Button(t("hn.needGo")) { pushRoute = .interview }
            Button(t("common.cancel"), role: .cancel) {}
        } message: {
            Text(t("hn.needBody"))
        }
        .alert("先完成实人认证", isPresented: $needKyc) {
            Button("去认证") { pushRoute = .web("/kyc?next=/me") }
            Button("以后再说", role: .cancel) {}
        } message: {
            Text("聊天、发动态、评论都要先做实人认证。\n身份证 + 刷脸，¥1 从 AI 余额扣。")
        }
        .routePush($pushRoute)
        .sheet(isPresented: $showAttach) {
            AttachSheet(
                isSingle: convType == 1,
                canVideoCall: true,
                canFile: true,
                onClose: { showAttach = false },
                onSendAssets: sendAttachAssets,
                onSendDatas: sendAttachDatas,
                onAction: handleAttach
            )
            .attachSheetDetents()
            .compatSheetBackground(Theme.bg)
        }
        .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { sendFiles(urls) }
        }
        .fullScreenCover(item: $fullImage) { img in
            let imgs = messages.filter { $0.type == "image" }.map { imageUrlOf($0.content) }.filter { !$0.isEmpty }
            ImageViewerView(images: imgs.isEmpty ? [img] : imgs, initial: max(0, imgs.firstIndex(of: img) ?? 0), onScanQr: onImageQr) {
                fullImage = nil
            }
        }
    }

    /// 大图里认出的二维码：等查看器收起再交给统一的扫码处理
    private func onImageQr(_ text: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { scannedQr = text }
    }

    private func clearChat() {
        Task {
            struct OkResp: Codable { var ok: Bool? }
            if let _: OkResp = try? await Api.request("/im/conversations/\(convId)/clear", method: "POST") {
                await reloadMessages()
            } else {
                toastMsg = t("channel.clearFailed")
            }
        }
    }

    private func onLoad() async {
        let around = focusPending ? focusMsgId.map { "&aroundId=\($0)" } ?? "" : ""
        let first: [MsgItem] = (try? await Api.request("/im/messages?conversationId=\(convId)\(around)")) ?? []
        // 列表回来前已发出去的消息别被覆盖
        messages = first + messages.filter { m in m.pending && !first.contains(where: { $0.id == m.id }) }
        Task { @MainActor in
            await loadPins()
        }
        if let last = messages.last { WsClient.shared.markRead(conversationId: convId, msgId: last.id) }
        WsClient.shared.connect()
        removeListener = WsClient.shared.addListener { frame in handleFrame(frame) }
}

    private func handleFrame(_ frame: [String: Any]) {
        let op = frame["op"] as? String
        if op == "error" {
            // 发送被后端拒绝：撤回乐观显示的消息；没完成资料收集的弹框带去 AI 红娘，其它的提示一下
            let code = frame["code"] as? String
            if code == "need_profile" {
                needProfile = true
            } else if code == "need_kyc" {
                // 后台要求先做实人认证：弹框带去认证页（网页）
                needKyc = true
            } else {
                toastMsg = frame["msg"] as? String ?? t("chat.sendFailed")
                // 没互相喜欢 / 对方已结束聊天：重新取一次关系，输入区换成说明
                if code == "need_like" || code == "chat_ended" { Task { await loadRel() } }
            }
            let tid = frame["tempId"] as? String
            let idx = tid != nil ? messages.firstIndex(where: { $0.id == tid }) : messages.lastIndex(where: { $0.id.hasPrefix("t_") })
            if let idx {
                messages.remove(at: idx)
            }
            return
        }
        if op == "ack" {
            // 乐观消息换成正式 id，菜单 / 回复 / 置顶才能用
            guard frameStr(frame["conversationId"]) == convId,
                  let tid = frame["tempId"] as? String,
                  let mid = frameStr(frame["msgId"]),
                  let idx = messages.firstIndex(where: { $0.id == tid }) else { return }
            if messages.contains(where: { $0.id == mid }) { messages.remove(at: idx); return }
            messages[idx].id = mid
            if let c = frame["createdAt"] as? String { messages[idx].createdAt = c }
            return
        }
        if op == "read" {
            guard frameStr(frame["conversationId"]) == convId,
                  (frameStr(frame["userId"]) ?? "") != myId else { return }
            for i in messages.indices where messages[i].senderId == myId { messages[i].isRead = true }
            return
        }
        if op == "msg_reactions" || op == "msg_pin" {
            guard let data = frame["data"] as? [String: Any],
                  frameStr(data["conversationId"]) == convId else { return }
            if op == "msg_pin" { Task { await loadPins() }; return }
            guard let id = frameStr(data["msgId"]),
                  let idx = messages.firstIndex(where: { $0.id == id }),
                  let raw = data["reactions"],
                  let json = try? JSONSerialization.data(withJSONObject: raw),
                  let rs = try? JSONDecoder().decode([MsgReaction].self, from: json) else { return }
            messages[idx].reactions = rs
            return
        }
        if op == "conv_cleared" {
            // 有人清空了记录：重新拉取同步
            if let data = frame["data"] as? [String: Any],
               (data["conversationId"] as? String) == convId {
                Task { await reloadMessages() }
            }
            return
        }
        if op == "msg_edit" || op == "msg_delete" {
            // 消息被改（文字）或撤回
            guard let data = frame["data"] as? [String: Any],
                  frameStr(data["conversationId"]) == convId,
                  let id = frameStr(data["msgId"]) else { return }
            if op == "msg_delete" {
                removeMsgs([id])
                if replyTo?.id == id { replyTo = nil }
                if pins.contains(where: { $0.id == id }) { Task { await loadPins() } }
            } else if let idx = messages.firstIndex(where: { $0.id == id }) {
                if let c = data["content"] as? String { messages[idx].content = c }
            }
            return
        }
        guard op == "msg",
              let data = frame["data"] as? [String: Any],
              let json = try? JSONSerialization.data(withJSONObject: data),
              let m = try? JSONDecoder().decode(MessagePayload.self, from: json),
              m.conversationId == convId,
              !messages.contains(where: { $0.id == m.id }) else { return }
        messages.append(MsgItem(id: m.id, conversationId: m.conversationId, senderId: m.senderId,
                                senderNickname: m.senderNickname, senderAvatar: m.senderAvatar,
                                receiverId: m.receiverId, type: m.type, content: m.content, createdAt: m.createdAt,
                                replyTo: m.replyTo, fwdFrom: m.fwdFrom, reactions: m.reactions))
        WsClient.shared.markRead(conversationId: convId, msgId: m.id)
    }

    // MARK: - 底部输入区（微信式）

    private var bottomBar: some View {
        VStack(spacing: 0) {
            if let r = replyTo {
                ReplyBar(nickname: r.senderNickname ?? "", snippet: msgSnippet(r.type, r.content)) { replyTo = nil }
            }
            HStack(alignment: .bottom, spacing: 8) {
                Button {
                    voiceMode.toggle(); showEmoji = false; inputFocused = false
                } label: {
                    Image(systemName: voiceMode ? "keyboard" : "waveform")
                        .font(.system(size: 17)).foregroundStyle(Theme.textSub)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(Theme.bg3))
                }
                .buttonStyle(.plain)

                if voiceMode {
                    Text(recording ? t("chat.releaseToSend") : t("chat.holdToTalk"))
                        .font(.system(size: 14))
                        .foregroundStyle(recording ? .white : Theme.text)
                        .frame(maxWidth: .infinity).frame(height: 40)
                        .background(Capsule().fill(recording ? Theme.accent : Theme.bg3))
                        .onLongPressGesture(minimumDuration: 60, maximumDistance: 80, pressing: { pressing in
                            if pressing { recording = true; recorderBox.start() }
                            else if recording { recording = false; finishRecording() }
                        }, perform: {})
                } else {
                    Group {
                        if #available(iOS 16.0, *) {
                            TextField("", text: $input, prompt: Text(t("chat.inputPlaceholder")).foregroundColor(Theme.textDim), axis: .vertical)
                                .lineLimit(1 ... 4)
                                .focused($inputFocused)
                        } else {
                            TextField("", text: $input, prompt: Text(t("chat.inputPlaceholder")).foregroundColor(Theme.textDim))
                                .focused($inputFocused)
                        }
                    }
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 20).fill(Theme.bg3))
                }

                // 表情按钮：面板顶替键盘
                Button {
                    inputFocused = false; voiceMode = false; showEmoji.toggle()
                } label: {
                    Image(systemName: "face.smiling")
                        .font(.system(size: 19)).foregroundStyle(showEmoji ? Theme.accent : Theme.textSub)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(showEmoji ? Theme.bubbleMine : Theme.bg3))
                }
                .buttonStyle(.plain)

                Button {
                    inputFocused = false; showEmoji = false; showAttach = true
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 18)).foregroundStyle(Theme.textSub)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(Theme.bg3))
                }
                .buttonStyle(.plain)

                if !voiceMode && !input.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button {
                        let text = input.trimmingCharacters(in: .whitespaces)
                        sendMsg("text", text)
                        input = ""
                    } label: {
                        Text(t("common.send")).font(.system(size: 14)).foregroundStyle(.white)
                            .padding(.horizontal, 16).frame(height: 40)
                            .background(Capsule().fill(Theme.accent))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(8)

            if showEmoji {
                // 「最近使用」由面板自己记
                EmojiPanel(
                    onEmoji: { input += $0 },
                    onDelete: { input = dropLastGrapheme(input) },
                    onKeyboard: { showEmoji = false; inputFocused = true }
                )
            }
        }
        .background(Theme.bg2)
    }

    private func handleAttach(_ action: AttachAction) {
        showAttach = false
        let peerAvatar = messages.first(where: { $0.senderId == targetId })?.senderAvatar ?? ""
        // 等弹框收起再弹通话页，两个 sheet 同时切换会丢一个
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            switch action {
            case .location: sendLocation()
            case .voiceCall: startCallWithPermissions(calleeId: targetId, type: 1, name: title, avatar: peerAvatar)
            // 视频通话仅男方可发起（女方只能接听），弹框里已按性别隐藏入口
            case .videoCall: startCallWithPermissions(calleeId: targetId, type: 2, name: title, avatar: peerAvatar)
            case .file: showFilePicker = true
            }
        }
    }

    // MARK: - 发图：选好立刻显示（本地预览 + 进度圈），后台最多同时传 3 张，按选择顺序发出；多张合成相册

    private func sendAttachAssets(_ assets: [PHAsset], caption: String) {
        showAttach = false
        let items: [(String, UploadSource, Int, Int)] = assets.map { a in
            (newUploadKey(), UploadSource.asset(a), a.pixelWidth, a.pixelHeight)
        }
        startImageSend(items, caption: caption)
        for (i, a) in assets.enumerated() {
            let key = items[i].0
            Task { @MainActor in
                if localImages[key] == nil, let img = await AttachMedia.preview(a) { localImages[key] = img }
            }
        }
    }

    private func sendAttachDatas(_ datas: [Data], caption: String) {
        showAttach = false
        var items: [(String, UploadSource, Int, Int)] = []
        for d in datas {
            let key = newUploadKey()
            let img = UIImage(data: d)
            if let img { localImages[key] = img }
            items.append((key, UploadSource.data(d), Int(img?.size.width ?? 0), Int(img?.size.height ?? 0)))
        }
        startImageSend(items, caption: caption)
    }

    private func newUploadKey() -> String {
        "local_\(UUID().uuidString.prefix(12))"
    }

    /// items：(upKey, 原图, 宽, 高)
    private func startImageSend(_ items: [(String, UploadSource, Int, Int)], caption: String) {
        guard !items.isEmpty else { return }
        let g: String? = items.count > 1 ? newAlbumId() : nil
        let r = replyTo
        replyTo = nil
        let preview = r.map {
            ReplyPreview(id: $0.id, senderId: $0.senderId, senderNickname: $0.senderNickname, type: $0.type,
                         content: $0.type == "text" ? String($0.content.prefix(100)) : ($0.type == "image" ? imageUrlOf($0.content) : ""))
        }
        let now = ISO8601DateFormatter().string(from: Date())
        for (i, it) in items.enumerated() {
            upSources[it.0] = it.1
            uploads[it.0] = UploadState()
            messages.append(MsgItem(
                id: it.0, conversationId: convId, senderId: myId,
                senderNickname: state.user?.nickname ?? "", senderAvatar: state.user?.avatar ?? "",
                receiverId: nil, type: "image", content: imageContent("", g: g, w: it.2, h: it.3),
                createdAt: now, replyTo: i == 0 ? preview : nil, upKey: it.0
            ))
        }
        let keys = items.map { $0.0 }
        let text = caption.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { @MainActor in
            await uploadInOrder(keys, upload: { k in await uploadOne(k) }, send: { k, url in
                if let tid = sendUploaded(k, url) { _ = await awaitAck(tid) }
            })
            if !text.isEmpty { sendMsg("text", text) }
        }
    }

    @MainActor
    private func uploadOne(_ key: String) async -> String? {
        guard let src = upSources[key] else { return nil }
        uploads[key] = UploadState()
        var data: Data?
        switch src {
        case .data(let d): data = d
        case .asset(let a): data = await AttachMedia.jpegData(a)
        }
        guard let data else {
            uploads[key] = UploadState(progress: 0, failed: true)
            return nil
        }
        if localImages[key] == nil, let img = UIImage(data: data) { localImages[key] = img }
        do {
            let url = try await Api.upload("image", data: data, filename: "img.jpg", mime: "image/jpeg", progress: { p in
                if let s = uploads[key], !s.failed { uploads[key] = UploadState(progress: p, failed: false) }
            })
            uploads[key] = nil
            return url
        } catch {
            uploads[key] = UploadState(progress: 0, failed: true)
            return nil
        }
    }

    /// 传完的图发出去：本地那条换成 tempId，等 ack；回复引用挂在第一张上
    @MainActor @discardableResult
    private func sendUploaded(_ key: String, _ url: String) -> String? {
        guard let idx = messages.firstIndex(where: { $0.upKey == key }) else { return nil }
        let meta = parseImage(messages[idx].content)
        let content = imageContent(url, g: meta.g, w: meta.w, h: meta.h)
        let tempId = WsClient.shared.send(convType: convType, targetId: targetId, msgType: "image", content: content, replyToId: messages[idx].replyTo?.id)
        messages[idx].id = tempId
        messages[idx].content = content
        upSources[key] = nil
        return tempId
    }

    private func retryUpload(_ m: MsgItem) {
        guard let key = m.upKey else { return }
        Task { @MainActor in
            if m.type == "file" || m.type == "video" {
                if let c = await uploadPicked(key) { sendPicked(key, c) }
                return
            }
            if let url = await uploadOne(key) { sendUploaded(key, url) }
        }
    }

    // MARK: - 「文件」里选的：图片走发图，音频按语音发，视频 / 文件立刻显示带进度的占位，按顺序一个个传

    private func sendFiles(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        Task { @MainActor in
            let picked = await Task.detached { urls.map(prepareChatFile) }.value
            if let bad = picked.first(where: { $0.copy == nil }) {
                toastMsg = bad.size == 0 || bad.size > Api.fileMaxSize
                    ? t(bad.size == 0 ? "chat.file.empty" : "chat.file.tooLarge", ["name": bad.name])
                    : t("common.uploadFailed")
            }
            let ok = picked.filter { $0.copy != nil }

            let images = ok.filter { $0.kind == .image }
            let datas = images.compactMap { f in f.copy.flatMap { UIImage(contentsOfFile: $0.path)?.attachJPEG() } }
            images.forEach { if let c = $0.copy { removeChatFileCopy(c) } }
            if !datas.isEmpty { sendAttachDatas(datas, caption: "") }

            let items = ok.filter { $0.kind == .video || $0.kind == .file }
            let r = items.isEmpty ? nil : replyTo
            if r != nil { replyTo = nil }
            let preview = r.map {
                ReplyPreview(id: $0.id, senderId: $0.senderId, senderNickname: $0.senderNickname, type: $0.type,
                             content: $0.type == "text" ? String($0.content.prefix(100)) : ($0.type == "image" ? imageUrlOf($0.content) : ""))
            }
            let now = ISO8601DateFormatter().string(from: Date())
            var keys: [String] = []
            for (i, f) in items.enumerated() {
                let key = newUploadKey()
                keys.append(key)
                upPicked[key] = f
                uploads[key] = UploadState()
                let video = f.kind == .video
                messages.append(MsgItem(
                    id: key, conversationId: convId, senderId: myId,
                    senderNickname: state.user?.nickname ?? "", senderAvatar: state.user?.avatar ?? "",
                    receiverId: nil, type: video ? "video" : "file", content: video ? "" : chatFileContent(name: f.name, size: f.size, mime: f.mime),
                    createdAt: now, replyTo: i == 0 ? preview : nil, upKey: key
                ))
            }

            for a in ok where a.kind == .audio {
                guard let src = a.copy else { continue }
                do {
                    let url = try await Api.uploadFromFile("audio", fileURL: src, name: a.name, mime: a.mime)
                    sendMsg("audio", "{\"url\":\"\(url)\",\"duration\":\(a.duration)}")
                } catch {
                    toastMsg = error.localizedDescription
                }
                removeChatFileCopy(src)
            }
            for key in keys {
                if let c = await uploadPicked(key), let tid = sendPicked(key, c) { _ = await awaitAck(tid) }
            }
        }
    }

    /// 传完返回消息 content：视频是地址，文件是 { url, name, size, mime }
    @MainActor
    private func uploadPicked(_ key: String) async -> String? {
        guard let p = upPicked[key], let src = p.copy, let m = messages.first(where: { $0.upKey == key }) else { return nil }
        uploads[key] = UploadState()
        let onProgress: (Double) -> Void = { v in
            if let s = uploads[key], !s.failed { uploads[key] = UploadState(progress: v, failed: false) }
        }
        do {
            let content: String
            if m.type == "video" {
                content = try await Api.uploadFromFile("video", fileURL: src, name: p.name, mime: p.mime, progress: onProgress)
            } else {
                let r = try await Api.uploadChatFile(src, name: p.name, mime: p.mime, progress: onProgress)
                content = chatFileContent(name: r.name, size: r.size, mime: r.mime, url: r.url)
            }
            uploads[key] = nil
            return content
        } catch {
            uploads[key] = UploadState(progress: 0, failed: true)
            toastMsg = error.localizedDescription
            return nil
        }
    }

    @MainActor @discardableResult
    private func sendPicked(_ key: String, _ content: String) -> String? {
        guard let idx = messages.firstIndex(where: { $0.upKey == key }) else { return nil }
        let tempId = WsClient.shared.send(convType: convType, targetId: targetId, msgType: messages[idx].type, content: content, replyToId: messages[idx].replyTo?.id)
        messages[idx].id = tempId
        messages[idx].content = content
        if let copy = upPicked.removeValue(forKey: key)?.copy { removeChatFileCopy(copy) }
        return tempId
    }

    private func shouldShowTime(_ idx: Int) -> Bool {
        guard let cur = parseIsoDate(messages[idx].createdAt) else { return false }
        guard idx > 0, let prev = parseIsoDate(messages[idx - 1].createdAt) else { return idx == 0 }
        return cur.timeIntervalSince(prev) > 300
    }

    /// 重新拉取消息列表（清空记录后本端及其他端同步用）
    private func reloadMessages() async {
        messages = (try? await Api.request("/im/messages?conversationId=\(convId)")) ?? []
    }

    /// 对方头像兜底：从消息列表里找一条对方的非空头像（个别消息头像缺失时使用）
    private var peerAvatarGuess: String {
        let myId = state.user?.id ?? ""
        return messages.first(where: { $0.senderId != myId && ($0.senderAvatar?.isEmpty == false) })?.senderAvatar ?? ""
    }

    // MARK: - 发送

    /// 发消息并乐观显示（tempId 等 ack 换成正式 id）；正在回复的话只挂在这一条上
    private func sendMsg(_ type: String, _ content: String) {
        let r = replyTo
        replyTo = nil
        let tempId = WsClient.shared.send(convType: convType, targetId: targetId, msgType: type, content: content, replyToId: r?.id)
        let preview = r.map {
            ReplyPreview(id: $0.id, senderId: $0.senderId, senderNickname: $0.senderNickname, type: $0.type,
                         content: $0.type == "text" ? String($0.content.prefix(100)) : ($0.type == "image" ? $0.content : ""))
        }
        messages.append(MsgItem(
            id: tempId,
            conversationId: convId, senderId: myId,
            senderNickname: state.user?.nickname ?? "", senderAvatar: state.user?.avatar ?? "",
            receiverId: nil, type: type, content: content,
            createdAt: ISO8601DateFormatter().string(from: Date()),
            replyTo: preview
        ))
    }

    // MARK: - 长按菜单

    private func makeBubble(_ row: ChatRow) -> MsgBubble {
        let m = row.first
        let mine = m.senderId == myId
        return MsgBubble(
            m: m, mine: mine,
            fallbackAvatar: mine ? (state.user?.avatar ?? "") : peerAvatarGuess,
            myId: myId,
            onMenu: { inputFocused = false; showEmoji = false; menuMsg = m },
            onReact: { react(m.id, $0) },
            onJump: { jumpTo($0) },
            onImage: { url in if !url.isEmpty { fullImage = url } },
            album: row.isAlbum ? row.items : nil,
            uploads: uploads,
            localImages: localImages,
            onItemMenu: { item in
                guard !item.pending else { return }
                inputFocused = false; showEmoji = false; menuMsg = item
            },
            onItemReact: { item, e in react(item.id, e) },
            onRetry: { item in retryUpload(item) }
        )
    }

    @ViewBuilder
    private func messageRow(_ row: ChatRow) -> some View {
        if let sel = selecting {
            selectableRow(row, sel)
        } else {
            makeBubble(row)
        }
    }

    /// 多选模式：相册整组一起勾选
    private func selectableRow(_ row: ChatRow, _ sel: Set<String>) -> some View {
        let ids = row.items.map(\.id)
        let on = ids.allSatisfy { sel.contains($0) }
        let pending = row.items.contains { $0.pending }
        return HStack(spacing: 6) {
            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 20))
                .foregroundStyle(on ? linkBlue : Theme.textDim)
            makeBubble(row).allowsHitTesting(false)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard !pending else { return }
            var s = sel
            if on { s.subtract(ids) } else { s.formUnion(ids) }
            selecting = s
        }
    }

    private func selectBar(_ sel: Set<String>) -> some View {
        let chosen = messages.filter { sel.contains($0.id) }
        return HStack {
            Button(t("common.cancel")) { selecting = nil }
                .font(.system(size: 15)).foregroundStyle(Theme.textSub)
            Spacer()
            Text(t("chat.selectedN", ["n": sel.count])).font(.system(size: 14)).foregroundStyle(Theme.text)
            Spacer()
            Button {
                let ok = chosen.filter { FORWARDABLE.contains($0.type) }.map(\.id)
                if ok.isEmpty { toastMsg = t("chat.cantForward"); return }
                if ok.count < chosen.count { toastMsg = t("chat.partForward") }
                forwardIds = IdList(ids: ok)
            } label: {
                Image(systemName: "arrowshape.turn.up.right").font(.system(size: 18))
            }
            .foregroundStyle(sel.isEmpty ? Theme.textDim : linkBlue)
            .disabled(sel.isEmpty)
            .padding(.trailing, 18)
            Button {
                deleteIds = chosen.map(\.id)
            } label: {
                Image(systemName: "trash").font(.system(size: 18))
            }
            .foregroundStyle(sel.isEmpty ? Theme.textDim : Color.red)
            .disabled(sel.isEmpty)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16).padding(.vertical, 14)
        .background(Theme.bg2)
    }

    private func canDeleteForAll(_ m: MsgItem) -> Bool {
        m.senderId == myId
    }

    private func menuActions(_ m: MsgItem) -> MenuActions {
        let mine = m.senderId == myId
        let pinned = pins.contains(where: { $0.id == m.id })
        var a = MenuActions(onReact: { react(m.id, $0) })
        a.onReply = { replyTo = m; inputFocused = true }
        if m.type == "text" {
            a.onCopy = { UIPasteboard.general.string = m.content; toastMsg = t("common.copied") }
        }
        if m.type == "image" || m.type == "video" {
            let url = m.type == "image" ? imageUrlOf(m.content) : m.content
            a.onSave = { Task { @MainActor in toastMsg = await saveMediaToPhotos(type: m.type, url: url) } }
        }
        if m.type == "file", parseChatFile(m.content).url != nil {
            let f = parseChatFile(m.content)
            a.onSave = { Task { @MainActor in if !(await ChatFileOpener.open(f)) { toastMsg = t("chat.file.downloadFailed") } } }
        }
        if canPin { a.onPin = { togglePin(m.id, pin: !pinned) } }
        if FORWARDABLE.contains(m.type) { a.onForward = { forwardIds = IdList(ids: [m.id]) } }
        if !mine { a.onReport = { reportId = m.id } }
        a.onDelete = { deleteIds = [m.id] }
        a.onSelect = { selecting = [m.id] }
        return a
    }

    private func msgActionLayers<V: View>(_ content: V) -> some View {
        let delCanForAll = (deleteIds ?? []).allSatisfy { id in
            messages.first(where: { $0.id == id }).map { canDeleteForAll($0) } ?? false
        }
        let delCount = deleteIds?.count ?? 0
        return content
            .overlay {
                if let m = menuMsg {
                    MsgMenuOverlay(
                        msgId: m.id, mine: m.senderId == myId,
                        myReaction: m.reactions?.first(where: { $0.userIds.contains(myId) })?.emoji,
                        pinned: pins.contains(where: { $0.id == m.id }),
                        actions: menuActions(m),
                        onDismiss: { menuMsg = nil }
                    )
                    .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.15), value: menuMsg?.id)
            .confirmationDialog(
                delCount > 1 ? t("msg.deleteN", ["n": delCount]) : t("msg.deleteOne"),
                isPresented: Binding(get: { deleteIds != nil }, set: { if !$0 { deleteIds = nil } }),
                titleVisibility: .visible
            ) {
                if delCanForAll {
                    Button(t("msg.deleteForMeAndPeer", ["name": title]), role: .destructive) {
                        if let ids = deleteIds { doDelete(ids, forAll: true) }
                    }
                    Button(t("msg.deleteForMeOnly"), role: .destructive) {
                        if let ids = deleteIds { doDelete(ids, forAll: false) }
                    }
                } else {
                    Button(t("common.delete"), role: .destructive) {
                        if let ids = deleteIds { doDelete(ids, forAll: false) }
                    }
                }
                Button(t("common.cancel"), role: .cancel) { deleteIds = nil }
            } message: {
                if !delCanForAll { Text(t("msg.deleteForMeHint")) }
            }
            .sheet(item: $reportId) { id in
                ReportSheet(msgId: id) { toastMsg = $0 }
                    .compatDetents(height: 420)
            }
            .sheet(item: $forwardIds) { list in
                ForwardSheet(fromConvId: convId, ids: list.ids) { tip in
                    toastMsg = tip
                    if tip == t("msg.forwarded") { selecting = nil }
                }
            }
    }

    private func loadPins() async {
        pins = (try? await Api.request("/im/conversations/\(convId)/pins")) ?? []
        pinIdx = 0
    }

    private func react(_ id: String, _ emoji: String) {
        Task { @MainActor in
            struct ReactResp: Codable { var reactions: [MsgReaction] }
            do {
                let r: ReactResp = try await Api.request("/im/messages/\(id)/react", method: "POST", body: ["emoji": emoji])
                if let idx = messages.firstIndex(where: { $0.id == id }) { messages[idx].reactions = r.reactions }
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    private func togglePin(_ id: String, pin: Bool) {
        Task { @MainActor in
            struct OkResp: Codable { var ok: Bool? }
            do {
                let _: OkResp = try await Api.request("/im/messages/\(id)/pin", method: "POST", body: ["pin": pin])
                await loadPins()
                toastMsg = pin ? t("chat.pinned") : t("chat.unpinned")
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    private func removeMsgs(_ ids: Set<String>) {
        messages.removeAll { ids.contains($0.id) }
    }

    private func doDelete(_ ids: [String], forAll: Bool) {
        deleteIds = nil
        Task { @MainActor in
            struct DelResp: Codable { var deleted: Int? }
            do {
                let _: DelResp = try await Api.request("/im/messages/delete", method: "POST", body: [
                    "conversationId": convId, "ids": ids, "forAll": forAll,
                ])
                removeMsgs(Set(ids))
                if let r = replyTo, ids.contains(r.id) { replyTo = nil }
                selecting = nil
                if pins.contains(where: { ids.contains($0.id) }) { await loadPins() }
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    /// 跳到某条消息（回复引用 / 置顶条）；不在当前列表就按 aroundId 重新拉一段
    private func jumpTo(_ id: String) {
        if messages.contains(where: { $0.id == id }) { jumpReq = id; return }
        Task { @MainActor in
            let list: [MsgItem] = (try? await Api.request("/im/messages?conversationId=\(convId)&aroundId=\(id)")) ?? []
            guard list.contains(where: { $0.id == id }) else { toastMsg = t("chat.originalGone"); return }
            messages = list
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { jumpReq = id }
        }
    }

    private func finishRecording() {
        guard let (data, dur) = recorderBox.stop() else { return }
        Task {
            if let url = try? await Api.upload("audio", data: data, filename: "a.m4a", mime: "audio/m4a") {
                let content = "{\"url\":\"\(url)\",\"duration\":\(dur)}"
                sendMsg("audio", content)
            }
        }
    }

    private func sendLocation() {
        toastMsg = t("chat.locating")
        CityLocator.shared.currentLocation { loc, addr in
            DispatchQueue.main.async {
                // 没拿到位置就提示，不发 0,0
                guard let loc else { toastMsg = t("msg.locFailed"); return }
                let name = (addr?.isEmpty == false) ? addr! : t("chat.myLocation")
                let dict: [String: Any] = ["name": name, "lat": loc.coordinate.latitude, "lng": loc.coordinate.longitude]
                if let d = try? JSONSerialization.data(withJSONObject: dict), let s = String(data: d, encoding: .utf8) {
                    sendMsg("location", s)
                }
            }
        }
    }
}

extension String: @retroactive Identifiable {
    public var id: String { self }
}

/// 微信式消息气泡
/// 语音气泡声条：播放时三根声条循环跳动，静止时固定高度
struct VoiceBars: View {
    let playing: Bool
    let color: Color
    /// 由定时任务翻转驱动动画（不用 repeatForever，保证停止即刻生效）
    @State private var up = false

    private static let baseHeights: [CGFloat] = [6, 11, 15]
    private static let altHeights: [CGFloat] = [15, 6, 10]

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(0..<3, id: \.self) { i in
                Capsule()
                    .fill(color)
                    .frame(width: 3, height: (playing && up) ? Self.altHeights[i] : Self.baseHeights[i])
                    .animation(.easeInOut(duration: 0.3), value: up)
                    .animation(.easeOut(duration: 0.15), value: playing)
            }
        }
        .frame(width: 16, height: 16)
        .task(id: playing) {
            guard playing else { up = false; return }
            while !Task.isCancelled {
                up.toggle()
                try? await Task.sleep(nanoseconds: 320_000_000)
            }
        }
    }
}

struct MsgBubble: View {
    let m: MsgItem
    let mine: Bool
    /// 消息本身头像缺失时的兜底
    var fallbackAvatar: String = ""
    var myId: String = ""
    var onMenu: (() -> Void)? = nil
    var onReact: ((String) -> Void)? = nil
    var onJump: ((String) -> Void)? = nil
    var onImage: (String) -> Void
    /// 多图相册（第一张就是 m）
    var album: [MsgItem]? = nil
    /// 本地刚选的图：上传状态、预览图（按 upKey）
    var uploads: [String: UploadState] = [:]
    var localImages: [String: UIImage] = [:]
    /// 相册里长按 / 回应的是哪一张
    var onItemMenu: ((MsgItem) -> Void)? = nil
    var onItemReact: ((MsgItem, String) -> Void)? = nil
    var onRetry: ((MsgItem) -> Void)? = nil

    @State private var voicePlaying = false
    @State private var voiceStopTask: Task<Void, Never>?

    private var bg: Color { mine ? Theme.bubbleMine : Theme.bg3 }
    /// 浅色主题：自己的气泡是浅玫红底，文字同样用深色
    private var fg: Color { Theme.text }

    private var avatarUrl: String {
        (m.senderAvatar?.isEmpty == false) ? m.senderAvatar! : fallbackAvatar
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if mine { Spacer(minLength: 50) }
            if !mine { AvatarView(url: avatarUrl, size: 38) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
                if !mine {
                    Text(m.senderNickname ?? "").font(.system(size: 11)).foregroundStyle(Theme.textSub)
                        .padding(.leading, 4)
                }
                if let f = m.fwdFrom, !f.isEmpty {
                    Text(t("chat.forwardedFrom", ["name": f])).font(.system(size: 11)).foregroundStyle(linkBlue).padding(.horizontal, 4)
                }
                if let r = m.replyTo {
                    ReplyQuote(r: r) { onJump?(r.id) }
                }
                if let album {
                    albumView(album)
                    albumReactionChips(album)
                } else {
                    content
                        .simultaneousGesture(LongPressGesture(minimumDuration: 0.35).onEnded { _ in
                            if !m.pending { onMenu?() }
                        })
                    if let rs = m.reactions, !rs.isEmpty {
                        ReactionChips(reactions: rs, myId: myId) { onReact?($0) }
                    }
                }
                if uploadFailed {
                    Text(t("chat.upload.failed")).font(.system(size: 11)).foregroundStyle(Color.red).padding(.horizontal, 4)
                }
            }
            .frame(maxWidth: 240, alignment: mine ? .trailing : .leading)
            if mine { AvatarView(url: avatarUrl, size: 38) }
            if !mine { Spacer(minLength: 50) }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    private var bubbleShape: CompatUnevenRounded {
        mine
            ? CompatUnevenRounded(topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 4)
            : CompatUnevenRounded(topLeadingRadius: 4, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 16)
    }

    // MARK: 图片 / 相册

    private func uploadOf(_ item: MsgItem) -> UploadState? {
        guard let k = item.upKey else { return nil }
        return uploads[k]
    }

    private func localOf(_ item: MsgItem) -> UIImage? {
        guard let k = item.upKey else { return nil }
        return localImages[k]
    }

    private var uploadFailed: Bool {
        let list = album ?? [m]
        return list.contains { uploadOf($0)?.failed == true }
    }

    /// 单张图：有宽高按比例显示（最宽 200、最高 260），没有就 160 见方
    private var singleImage: some View {
        let meta = parseImage(m.content)
        let size = singleImageSize(w: meta.w, h: meta.h, maxW: 200, maxH: 260) ?? CGSize(width: 160, height: 160)
        let up = uploadOf(m)
        return ChatImageView(url: meta.url, local: localOf(m))
            .frame(width: size.width, height: size.height)
            .clipped()
            .overlay(UploadOverlay(state: up, sending: m.pending, onRetry: { onRetry?(m) }))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
            .onTapGesture { if up == nil { onImage(meta.url) } }
    }

    private func albumView(_ list: [MsgItem]) -> some View {
        let cells: [AlbumCell] = list.map { a in
            let meta = parseImage(a.content)
            return AlbumCell(id: a.upKey ?? a.id, url: meta.url, local: localOf(a), w: meta.w, h: meta.h, state: uploadOf(a), sending: a.pending)
        }
        return ImageAlbumView(
            cells: cells, width: 240,
            onTap: { i in
                if uploadOf(list[i]) == nil { onImage(imageUrlOf(list[i].content)) }
            },
            onLongPress: { i in onItemMenu?(list[i]) },
            onRetry: { i in onRetry?(list[i]) }
        )
    }

    /// 相册几张图的回应合在一起显示
    private func mergedReactions(_ list: [MsgItem]) -> [MsgReaction] {
        var order: [String] = []
        var map: [String: MsgReaction] = [:]
        for item in list {
            for r in item.reactions ?? [] {
                if var cur = map[r.emoji] {
                    cur.count += r.count
                    cur.userIds += r.userIds
                    map[r.emoji] = cur
                } else {
                    map[r.emoji] = r
                    order.append(r.emoji)
                }
            }
        }
        return order.compactMap { map[$0] }
    }

    /// 点合并后的回应：自己回应过这个表情的那张就取消那张的，否则回应第一张
    private func reactTarget(_ list: [MsgItem], _ emoji: String) -> MsgItem {
        let hit = list.first { item in
            (item.reactions ?? []).contains { $0.emoji == emoji && $0.userIds.contains(myId) }
        }
        return hit ?? list[0]
    }

    @ViewBuilder
    private func albumReactionChips(_ list: [MsgItem]) -> some View {
        if !mergedReactions(list).isEmpty {
            ReactionChips(reactions: mergedReactions(list), myId: myId) { e in onItemReact?(reactTarget(list, e), e) }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch m.type {
        case "image":
            singleImage
        case "audio":
            let obj = parseJson(m.content)
            let url = obj["url"] as? String ?? m.content
            let dur = (obj["duration"] as? Int) ?? Int(obj["duration"] as? String ?? "1") ?? 1
            Button {
                voiceStopTask?.cancel()
                voicePlaying = true
                // 播放真正结束时停止动画（切换到别的语音时也会回调）
                AudioPlayerBox.shared.play(url) {
                    voiceStopTask?.cancel()
                    voicePlaying = false
                }
                // 兜底：加载失败等情况按时长 + 3 秒强制停止
                voiceStopTask = Task {
                    try? await Task.sleep(nanoseconds: UInt64(dur + 3) * 1_000_000_000)
                    if !Task.isCancelled { voicePlaying = false }
                }
            } label: {
                HStack(spacing: 8) {
                    VoiceBars(playing: voicePlaying, color: fg)
                    Text("\(dur)\"").font(.system(size: 14)).foregroundStyle(fg)
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .frame(minWidth: 70 + CGFloat(min(dur, 18)) * 8, alignment: .leading)
                .background(bubbleShape.fill(bg))
            }
            .buttonStyle(.plain)
        case "file":
            FileBubbleView(f: parseChatFile(m.content), state: uploadOf(m), shape: bubbleShape, bg: bg, onRetry: { onRetry?(m) })
        case "video":
            ChatVideoTile(url: m.content, state: uploadOf(m), sending: m.pending, onRetry: { onRetry?(m) })
        case "location":
            let obj = parseJson(m.content)
            HStack(spacing: 8) {
                Image(systemName: "mappin.and.ellipse").font(.system(size: 14)).foregroundStyle(fg)
                Text(obj["name"] as? String ?? t("chat.location")).font(.system(size: 14)).foregroundStyle(fg)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(bubbleShape.fill(bg))
        case "call":
            let obj = parseJson(m.content)
            let callType = (obj["callType"] as? Int) ?? 1
            let result = obj["result"] as? String ?? "end"
            let dur = (obj["duration"] as? Int) ?? 0
            HStack(spacing: 8) {
                Image(systemName: callType == 2 ? "video.fill" : "phone.fill")
                    .font(.system(size: 14)).foregroundStyle(fg)
                Text(callText(callType: callType, result: result, duration: dur))
                    .font(.system(size: 14)).foregroundStyle(fg)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(bubbleShape.fill(bg))
        default:
            LinkText(text: m.content)
                .font(.system(size: 15)).foregroundStyle(fg)
                .lineSpacing(4)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(bubbleShape.fill(bg))
                .contentShape(Rectangle())
        }
    }

    private func parseJson(_ s: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any]) ?? [:]
    }

    private func callText(callType: Int, result: String, duration: Int) -> String {
        let label = callType == 2 ? t("chat.call.video") : t("chat.call.voice")
        switch result {
        case "end": return "\(label) \(String(format: "%02d:%02d", duration / 60, duration % 60))"
        case "reject": return t("chat.call.rejected", ["label": label])
        default: return t("chat.call.canceled", ["label": label])
        }
    }
}

/// 图片查看器：左右翻页 + 双指缩放 + 关闭按钮；传了 onScanQr 时底部多一个「识别二维码」（认出来就关掉查看器，交给统一的扫码处理）
struct ImageViewerView: View {
    let images: [String]
    let initial: Int
    var onScanQr: ((String) -> Void)?
    var onClose: () -> Void
    @State private var page: Int
    @State private var scanning = false
    @State private var toastMsg: String?

    init(images: [String], initial: Int, onScanQr: ((String) -> Void)? = nil, onClose: @escaping () -> Void) {
        self.images = images
        self.initial = initial
        self.onScanQr = onScanQr
        self.onClose = onClose
        _page = State(initialValue: initial)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            TabView(selection: $page) {
                ForEach(Array(images.enumerated()), id: \.offset) { idx, url in
                    ZoomableImage(url: Api.fullUrl(url))
                        .tag(idx)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: images.count > 1 ? .automatic : .never))

            Button { onClose() } label: {
                Text("×").font(.system(size: 22)).foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(.white.opacity(0.15)))
            }
            .buttonStyle(.plain)
            .padding(16)
        }
        .overlay(alignment: .bottom) { scanButton }
        .toast($toastMsg)
    }

    @ViewBuilder private var scanButton: some View {
        if onScanQr != nil {
            Button { scanCurrent() } label: {
                Text(scanning ? t("chat.qrScanning") : t("chat.scanQr"))
                    .font(.system(size: 14)).foregroundStyle(.white)
                    .padding(.horizontal, 16).padding(.vertical, 9)
                    .background(Capsule().fill(.white.opacity(0.18)))
            }
            .buttonStyle(.plain)
            .padding(.bottom, 48)
        }
    }

    private func scanCurrent() {
        guard !scanning, images.indices.contains(page), let url = URL(string: Api.fullUrl(images[page])) else { return }
        scanning = true
        Task { @MainActor in
            var text: String?
            if let pair = try? await URLSession.shared.data(from: url), let img = UIImage(data: pair.0) {
                text = detectQrCode(img)
            }
            scanning = false
            guard let code = text else {
                toastMsg = t("chat.noQrFound")
                return
            }
            onClose()
            onScanQr?(code)
        }
    }
}

/// 识别图片里的二维码（CIDetector，高精度）；没有返回 nil
func detectQrCode(_ image: UIImage) -> String? {
    guard let ci = CIImage(image: image) else { return nil }
    let options: [String: Any] = [CIDetectorAccuracy: CIDetectorAccuracyHigh]
    guard let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: options) else { return nil }
    for f in detector.features(in: ci) {
        if let q = f as? CIQRCodeFeature, let s = q.messageString, !s.isEmpty { return s }
    }
    return nil
}

/// 可缩放图片（双指缩放 + 双击还原/放大）
struct ZoomableImage: View {
    let url: String
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        GeometryReader { geo in
            AsyncImage(url: URL(string: url)) { image in
                image.resizable().scaledToFit()
            } placeholder: {
                ProgressView().tint(.white)
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .scaleEffect(scale)
            .offset(offset)
            .gesture(
                MagnificationGesture()
                    .onChanged { v in scale = max(1, lastScale * v) }
                    .onEnded { _ in lastScale = scale }
            )
            .simultaneousGesture(
                scale > 1
                    ? DragGesture()
                        .onChanged { v in
                            offset = CGSize(width: lastOffset.width + v.translation.width, height: lastOffset.height + v.translation.height)
                        }
                        .onEnded { _ in lastOffset = offset }
                    : nil
            )
            .onTapGesture(count: 2) {
                withAnimation {
                    if scale > 1 { scale = 1; lastScale = 1; offset = .zero; lastOffset = .zero }
                    else { scale = 2.5; lastScale = 2.5 }
                }
            }
        }
    }
}

/// 内部网页全屏预览（共用：AI 生成的 HTML 或聊天里点开的链接 url）
struct WebPreviewSheet: View {
    var html: String? = nil
    var url: URL? = nil
    var title: String? = nil
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(title ?? t("web.preview")).font(.system(size: 14)).foregroundStyle(Theme.text).lineLimit(1)
                Spacer()
                if let url, html == nil {
                    Menu {
                        Button(t("web.openInBrowser")) { UIApplication.shared.open(url) }
                        Button(t("web.copyLink")) { UIPasteboard.general.string = url.absoluteString }
                    } label: {
                        Image(systemName: "ellipsis.circle").font(.system(size: 17)).foregroundStyle(Theme.textSub)
                    }
                    .padding(.trailing, 10)
                }
                Button(t("common.close")) { dismiss() }
                    .font(.system(size: 14)).foregroundStyle(Theme.accent)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Theme.bg)
            WebContentView(html: html, url: url)
        }
        .background(Theme.bg)
    }
}

/// WKWebView 包装：渲染 HTML 字符串或加载 url
struct WebContentView: UIViewRepresentable {
    var html: String? = nil
    var url: URL? = nil

    func makeUIView(context: Context) -> WKWebView {
        let web = WKWebView()
        if let html { web.loadHTMLString(html, baseURL: nil) }
        else if let url { web.load(URLRequest(url: url)) }
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
