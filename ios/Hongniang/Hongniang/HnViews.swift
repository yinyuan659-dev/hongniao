import SwiftUI
import WebKit

/*
 * AI 红娘新页面共用的东西：新观感的颜色和小零件、内嵌网页容器、画像卡片、「我的」页卡片。
 * 新观感（暖色渐变底、白色圆角卡片、渐变按钮）和网页端 web/src/hn.css、安卓 HnScreens.kt 是一套，样稿在 design/。
 * 深聊是原生写的（DeepChatView.swift）；相亲画像和 AI 费用是网页，用这里的 HnWebPage 打开（用户 2026-11-23 定的）。
 * 注意：这个文件是照着安卓写的，iOS 没法在 Windows 上编译，没有编译验证过。
 */

enum HnTheme {
    static let rose = Color(red: 1.0, green: 0.239, blue: 0.388)
    static let coral = Color(red: 1.0, green: 0.518, blue: 0.412)
    static let ink = Color(red: 0.169, green: 0.110, blue: 0.133)
    static let ink2 = Color(red: 0.549, green: 0.490, blue: 0.514)
    static let ink3 = Color(red: 0.737, green: 0.690, blue: 0.706)
    static let soft = Color(red: 1.0, green: 0.239, blue: 0.388).opacity(0.09)
    static let line = Color(red: 0.169, green: 0.110, blue: 0.133).opacity(0.08)
    static let cream = Color(red: 1.0, green: 0.973, blue: 0.957)
    static let grad = LinearGradient(colors: [rose, coral], startPoint: .topLeading, endPoint: .bottomTrailing)
    /// 整页的底色：上粉、中间米白、下淡紫
    static let pageBg = LinearGradient(
        colors: [Color(red: 1.0, green: 0.886, blue: 0.910), cream, cream, Color(red: 0.953, green: 0.925, blue: 1.0)],
        startPoint: .top, endPoint: .bottom
    )
}

/// AI 红娘的头像：渐变小球 + 爱心
struct HnOrb: View {
    var size: CGFloat = 38
    var body: some View {
        Circle().fill(HnTheme.grad)
            .frame(width: size, height: size)
            .overlay(Image(systemName: "heart").font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(.white))
            .shadow(color: HnTheme.rose.opacity(0.32), radius: 7, x: 0, y: 5)
    }
}

/// 主按钮（渐变）/ 次按钮（白底）的外观；套在 Button 或 RouteLink 的 label 上
struct HnButtonLabel: View {
    let title: String
    var ghost = false
    var enabled = true
    var height: CGFloat = 50
    var body: some View {
        Text(title)
            .font(.system(size: ghost ? 15 : 16, weight: ghost ? .medium : .bold))
            .foregroundStyle(ghost ? HnTheme.ink : Color.white)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .background(Capsule().fill(ghost ? AnyShapeStyle(Color.white) : AnyShapeStyle(HnTheme.grad)))
            .opacity(enabled ? 1 : 0.45)
            .shadow(color: (ghost ? HnTheme.ink3 : HnTheme.rose).opacity(enabled ? 0.3 : 0), radius: 8, x: 0, y: 5)
    }
}

/// 小胶囊按钮的外观
struct HnPillLabel: View {
    let title: String
    var ghost = false
    var body: some View {
        Text(title)
            .font(.system(size: 13, weight: ghost ? .medium : .semibold))
            .foregroundStyle(ghost ? HnTheme.ink2 : Color.white)
            .padding(.horizontal, 16)
            .frame(height: 36)
            .background(Capsule().fill(ghost ? AnyShapeStyle(Color.white) : AnyShapeStyle(HnTheme.grad)))
            .shadow(color: (ghost ? HnTheme.ink3 : HnTheme.rose).opacity(0.28), radius: 5, x: 0, y: 3)
    }
}

/// 顶栏上的白色圆按钮（返回、更多）的外观
struct HnCircleIcon: View {
    let systemName: String
    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(HnTheme.ink)
            .frame(width: 34, height: 34)
            .background(Circle().fill(Color.white.opacity(0.9)))
            .shadow(color: HnTheme.ink3.opacity(0.35), radius: 3, x: 0, y: 1)
    }
}

// MARK: - 画像卡片（聊天里的那张，点开是相亲画像网页）

struct HnCardUser: Codable, Hashable {
    var id: String? = ""
    var nickname: String? = ""
    var age: Int? = 0
}

struct HnCardAi: Codable, Hashable {
    var summary: String? = ""
}

/// GET /hn/card/me 里画像卡片用到的那几项
struct HnCardBrief: Codable, Hashable {
    var user: HnCardUser? = nil
    var photos: [String]? = []
    /// 压在照片下方的小标签：城市、身高、学历、职业…
    var hero: [String]? = []
    var ai: HnCardAi? = nil
}

/// 聊天里的画像卡片：像别人发来的一条网页链接（外面包一层 Button / RouteLink 来点）
struct PortraitLinkCard: View {
    let card: HnCardBrief

    var body: some View {
        let name = card.user?.nickname ?? ""
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .bottomLeading) {
                Color(red: 0.945, green: 0.902, blue: 0.910)
                if let cover = card.photos?.first, !cover.isEmpty {
                    RemoteImage(url: cover).frame(maxWidth: .infinity).frame(height: 150).clipped()
                }
                LinearGradient(colors: [.clear, Color(red: 0.118, green: 0.047, blue: 0.071).opacity(0.78)], startPoint: .center, endPoint: .bottom)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .lastTextBaseline, spacing: 6) {
                        Text(name).font(.system(size: 20, weight: .heavy)).foregroundStyle(.white)
                        if let age = card.user?.age, age > 0 { Text("\(age)").font(.system(size: 17)).foregroundStyle(.white) }
                    }
                    HStack(spacing: 5) {
                        ForEach(Array((card.hero ?? []).prefix(4)), id: \.self) { h in
                            Text(h).font(.system(size: 11.5)).foregroundStyle(.white).lineLimit(1)
                                .padding(.horizontal, 10).padding(.vertical, 3)
                                .background(Capsule().fill(Color.white.opacity(0.24)))
                                .overlay(Capsule().stroke(Color.white.opacity(0.35), lineWidth: 1))
                        }
                    }
                }
                .padding(.horizontal, 14).padding(.bottom, 11)
            }
            .frame(height: 150)
            .clipped()

            VStack(alignment: .leading, spacing: 0) {
                Text("\(name)的相亲画像").font(.system(size: 15.5, weight: .heavy)).foregroundStyle(HnTheme.ink)
                Text(card.ai?.summary ?? "").font(.system(size: 13)).foregroundStyle(HnTheme.ink2).lineSpacing(4).lineLimit(2)
                    .padding(.top, 4)
                Rectangle().fill(HnTheme.line).frame(height: 1).padding(.top, 10)
                HStack {
                    Text("点开查看完整画像").font(.system(size: 12, weight: .semibold)).foregroundStyle(HnTheme.rose)
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(HnTheme.rose)
                }
                .padding(.top, 10)
            }
            .padding(EdgeInsets(top: 12, leading: 14, bottom: 13, trailing: 14))
        }
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 22))
        .shadow(color: HnTheme.rose.opacity(0.16), radius: 12, x: 0, y: 8)
        .frame(maxWidth: 330)
    }
}

// MARK: - 「我的」页最上面的画像卡片

/**
 * 我的相亲画像：基本情况（点选问答，必做）+ AI 深聊（可选）。右边的圈是完成度。
 * 「查看画像」打开相亲画像网页；深聊按钮进原生的深聊页；基本情况没填完时只有「继续填写」。
 */
struct MePortraitCard: View {
    let u: UserProfile

    private var deep: String { u.deepStatus ?? "none" }
    /// 完成度：只做完点选问答 62%，深聊也确认了 100%
    private var percent: Int {
        switch deep {
        case "done": return 100
        case "draft": return 90
        case "chatting": return 75
        default: return 62
        }
    }
    private var subtitle: String {
        if u.profileDone != true { return "基本情况还没填完\n填完才能主动找人聊天" }
        switch deep {
        case "done": return "基本情况和 AI 深聊都完成了\n想法变了可以再聊聊"
        case "draft": return "AI 红娘整理好了画像\n等你看一眼、点确认"
        case "chatting": return "基本情况已完成\n和 AI 红娘聊到一半"
        default: return "基本情况已完成\n再和 AI 红娘聊聊，推荐更准"
        }
    }
    private var deepLabel: String {
        switch deep {
        case "chatting": return "继续聊"
        case "draft": return "去确认画像"
        case "done": return "再聊聊"
        default: return "和 AI 红娘深聊"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("我的相亲画像").font(.system(size: 18, weight: .heavy)).foregroundStyle(.white)
                    Text(subtitle).font(.system(size: 12.5)).foregroundStyle(Color.white.opacity(0.92)).lineSpacing(4)
                }
                Spacer()
                if u.profileDone == true {
                    ZStack {
                        Circle().stroke(Color.white.opacity(0.28), lineWidth: 5)
                        Circle().trim(from: 0, to: CGFloat(percent) / 100)
                            .stroke(Color.white, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                        Text("\(percent)%").font(.system(size: 13, weight: .heavy)).foregroundStyle(.white)
                    }
                    .frame(width: 50, height: 50)
                }
            }
            HStack(spacing: 10) {
                if u.profileDone == true {
                    RouteLink(.web("/card/me")) { pill("查看画像  ›", solid: true) }.buttonStyle(.plain)
                    RouteLink(.deep) { pill("✦ \(deepLabel)", solid: false) }.buttonStyle(.plain)
                } else {
                    RouteLink(.interview) { pill("继续填写  ›", solid: true) }.buttonStyle(.plain)
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 26)
                .fill(LinearGradient(colors: [HnTheme.rose, HnTheme.coral, Color(red: 1.0, green: 0.655, blue: 0.478)], startPoint: .topLeading, endPoint: .bottomTrailing))
        )
        .shadow(color: HnTheme.rose.opacity(0.3), radius: 14, x: 0, y: 10)
    }

    private func pill(_ text: String, solid: Bool) -> some View {
        Text(text)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(solid ? HnTheme.rose : Color.white)
            .padding(.horizontal, 15)
            .frame(height: 34)
            .background(Capsule().fill(solid ? Color.white : Color.white.opacity(0.22)))
            .overlay(Capsule().stroke(Color.white.opacity(solid ? 0 : 0.45), lineWidth: 1))
    }
}

// MARK: - 登录设备：换登录身份、新设备登录的提醒

extension Notification.Name {
    /// 登录身份换了（刷脸找回成功、并号进了原来的账号、本机被别的设备移除）：RootView 收到后断开聊天连接、回启动页重新进入一次。
    /// 这台设备现在挂在哪个账号下由服务器说了算：挂着就登录那个账号，不认识了就去注册页。
    static let hnSessionChanged = Notification.Name("hnSessionChanged")
}

/**
 * 有新设备通过刷脸登录了这个账号（在线时服务器推送 op = device，不在线的下次启动时由「进入」带回来）→ RootView 弹提醒；
 * 本机被别的设备移除了 → 清掉登录身份，回启动页（会走到注册页）。
 */
final class DeviceCenter: ObservableObject {
    static let shared = DeviceCenter()

    /// 不是 nil 就弹「你的账号在新设备登录了」
    @Published var alert: NewDevice?
    /// 顶上弹一下的提示（这台设备已被移除）
    @Published var tip: String?

    private var listening = false

    /// 登录后调一次：监听登录设备相关的实时消息
    func start() {
        guard !listening else { return }
        listening = true
        WsClient.shared.addListener { frame in
            guard frame["op"] as? String == "device", let data = frame["data"] as? [String: Any] else { return }
            let event = frame["event"] as? String ?? ""
            let id = data["id"] as? String ?? ""
            let kind = data["kind"] as? String
            let label = data["label"] as? String
            let at = data["at"] as? String
            Task { @MainActor in
                let mine = Api.did ?? ""
                if event == "added", id != mine {
                    DeviceCenter.shared.alert = NewDevice(id: id, kind: kind, label: label, at: at)
                } else if event == "removed", !mine.isEmpty, id == mine {
                    Api.token = nil
                    Api.did = nil
                    DeviceCenter.shared.tip = "这台设备已被移除，已退出登录"
                    NotificationCenter.default.post(name: .hnSessionChanged, object: nil)
                }
            }
        }
    }
}

// MARK: - 内嵌网页：相亲画像、AI 费用

/**
 * 用 App 的登录身份打开 AI 红娘的某个网页（route 是 # 后面的路径，例如 /card/me、/ai-fee）。
 * 网页自己带顶栏和返回键，这里把系统导航栏藏掉。
 * 网页通过 JS 桥（window.webkit.messageHandlers.peiwan，type = hn）把这些动作交给原生：
 * 关掉这一页、回问答页改某一题、打开基本资料页、打开深聊页、看对方动态；「发消息」沿用大厅的 openChat。
 * 从别的原生页面回到这一页时，网页会重新加载，所以改完资料回来看到的是新内容。
 */
struct HnWebPage: View {
    let route: String
    @Environment(\.dismiss) private var dismiss
    @State private var push: Route?
    @State private var chatTarget: ChatTarget?
    @State private var appeared = false
    @StateObject private var holder = HnWebHolder()

    private var url: URL? {
        let sep = route.contains("?") ? "&" : "?"
        let token = Api.token ?? ""
        return URL(string: "\(Api.baseURL)/?_t=\(Int(Date().timeIntervalSince1970))#\(route)\(sep)token=\(token)&embed=1&lang=\(I18nStore.shared.lang)")
    }

    var body: some View {
        Group {
            if let url {
                HnWebView(
                    url: url, holder: holder,
                    onClose: { dismiss() },
                    onRoute: { push = $0 },
                    onOpenChat: { chatTarget = $0 }
                )
            } else {
                EmptyHint(text: t("common.loading"))
            }
        }
        .background(HnTheme.cream.ignoresSafeArea())
        .navigationBarHidden(true)
        .routePush($push)
        .fullScreenCover(item: $chatTarget) { target in
            ChatRoomSheet(target: target)
        }
        .onAppear {
            // 第一次出现是正常加载；之后再出现 = 从别的原生页面回来，重新加载拿最新内容
            if appeared { holder.web?.reload() }
            appeared = true
        }
    }
}

/// 让外面能拿到里面的 WKWebView（回来时重新加载用）
final class HnWebHolder: ObservableObject {
    weak var web: WKWebView?
}

private struct HnWebView: UIViewRepresentable {
    let url: URL
    let holder: HnWebHolder
    let onClose: () -> Void
    let onRoute: (Route) -> Void
    let onOpenChat: (ChatTarget) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onClose: onClose, onRoute: onRoute, onOpenChat: onOpenChat) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // 刷脸页打开摄像头后要自动播放预览画面
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(context.coordinator, name: "peiwan")
        // 标记：网页据此知道这是 AI 红娘的内嵌网页容器，可以用 hn 这组动作（大厅的容器没有这个标记）
        config.userContentController.addUserScript(WKUserScript(source: "window.__hnBridge=true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.addUserScript(GameLog.consoleForwardScript)
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(HnTheme.cream)
        web.scrollView.backgroundColor = UIColor(HnTheme.cream)
        web.scrollView.bounces = false
        web.allowsBackForwardNavigationGestures = true
        // 网页要用摄像头（阿里云的刷脸页）时由 Coordinator 决定给不给
        web.uiDelegate = context.coordinator
        holder.web = web
        GameLog.log("hn: webview created")
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "peiwan")
        uiView.stopLoading()
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKUIDelegate {
        let onClose: () -> Void
        let onRoute: (Route) -> Void
        let onOpenChat: (ChatTarget) -> Void

        init(onClose: @escaping () -> Void, onRoute: @escaping (Route) -> Void, onOpenChat: @escaping (ChatTarget) -> Void) {
            self.onClose = onClose
            self.onRoute = onRoute
            self.onOpenChat = onOpenChat
        }

        /// 网页申请用摄像头 / 麦克风：只给 https 页面（阿里云的刷脸页）、只给摄像头，别的一律不给。
        /// 给了以后系统还会按 App 自己的相机权限再问用户一次（Info.plist 的 NSCameraUsageDescription）。
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            let ok = origin.`protocol` == "https" && type == .camera
            GameLog.log("hn: media permission host=\(origin.host) camera=\(type == .camera) grant=\(ok)")
            decisionHandler(ok ? .grant : .deny)
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "peiwan", let body = message.body as? [String: Any] else { return }
            if GameLog.handleLogMessage(body, scope: "hn") { return }
            switch body["type"] as? String {
            case "hn":
                let action = body["action"] as? String ?? ""
                // 只认字母数字，防止网页拼出奇怪的东西
                let edit = (body["edit"] as? String ?? "").filter { $0.isLetter || $0.isNumber }
                let id = (body["id"] as? String ?? "").filter { $0.isNumber }
                let convId = (body["conversationId"] as? String ?? "").filter { $0.isNumber }
                let nickname = body["nickname"] as? String ?? ""
                let avatar = body["avatar"] as? String ?? ""
                // 换登录身份时网页给的新令牌和设备编号（令牌只会有字母数字和 . _ -）
                let token = (body["token"] as? String ?? "").filter { $0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-" }
                let did = (body["did"] as? String ?? "").filter { $0.isNumber }
                GameLog.log("hn: bridge action=\(action) edit=\(edit) id=\(id)")
                let onClose = onClose, onRoute = onRoute
                DispatchQueue.main.async {
                    switch action {
                    case "close": onClose()
                    // 真人认证通过了：稍等一下（让用户看到「认证通过」）再关掉网页；原生页面回到前面时会自己重新取状态
                    case "kycDone":
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { onClose() }
                    // 登录身份换了（刷脸找回成功、并号进了原来的账号）：换成网页给的令牌，关掉网页，回启动页重新进入一次
                    case "session":
                        if !token.isEmpty {
                            Api.token = token
                            Api.did = did.isEmpty ? nil : did
                            onClose()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                                NotificationCenter.default.post(name: .hnSessionChanged, object: nil)
                            }
                        }
                    case "interview": onRoute(edit.isEmpty ? .interview : .interviewEdit(edit))
                    case "editProfile": onRoute(.editProfile)
                    case "deep": onRoute(.deep)
                    case "userHome": if !id.isEmpty { onRoute(.userHomeNative(id)) }
                    // 在画像网页 / 喜欢列表里点喜欢，当场互相喜欢了：弹原生的庆祝页
                    case "matched":
                        if !id.isEmpty, !convId.isEmpty {
                            Task { @MainActor in
                                MatchCenter.shared.show(peer: MatchPeer(id: id, nickname: String(nickname.prefix(30)), avatar: avatar), conversationId: convId)
                            }
                        }
                    default: break
                    }
                }
            case "openChat":
                // 画像网页上的「发消息」：打开原生聊天页
                guard let convId = body["convId"] as? String, !convId.isEmpty else { return }
                let convType = (body["convType"] as? NSNumber)?.intValue ?? Int(body["convType"] as? String ?? "") ?? 1
                let targetId = body["targetId"] as? String ?? ""
                let title = body["title"] as? String ?? ""
                let onOpenChat = onOpenChat
                DispatchQueue.main.async {
                    onOpenChat(ChatTarget(convId: convId, convType: convType, targetId: targetId, title: title))
                }
            default:
                return
            }
        }
    }
}
