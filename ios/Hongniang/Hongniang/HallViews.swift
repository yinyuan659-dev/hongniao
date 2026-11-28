import Combine
import SwiftUI
import WebKit

/**
 * 大厅：App 内嵌的网页（WebView）。
 * 地址由后台给（GET /modules/hall，env HALL_H5_URL），没给就加载 Web 端的 /site/#/hall-embed，
 * URL 携带 token 免登录（用 App 的身份），页面内自行导航，其它 tab 保持原生。
 *
 * 只打开我们自己的网页（`Api.isOwnWebUrl`）：后台给的地址不是自己的就不用它；
 * 大厅页里点出去的链接、让 App 全屏打开的网页也一样，不是自己的一律不开。
 */
struct HallView: View {
    @State private var hallUrl: URL?
    @State private var chatTarget: ChatTarget?
    @State private var webTarget: WebTarget?
    @State private var mediaTarget: MediaTarget?
    @State private var h5Target: H5Target?

    var body: some View {
        Group {
            if let hallUrl {
                HallWebView(
                    url: hallUrl,
                    onOpenChat: { target in chatTarget = target },
                    onOpenWeb: { target in webTarget = target },
                    onViewMedia: { target in mediaTarget = target },
                    onOpenH5: { route in h5Target = H5Target(route: route) }
                )
            } else {
                EmptyHint(text: t("common.loading"))
            }
        }
        .fullBg()
        // H5 里点「打招呼」等经 JS 桥唤起原生聊天页
        .fullScreenCover(item: $chatTarget) { t in
            ChatRoomSheet(target: t)
        }
        // 养眼图片：看大图 / 播视频走原生查看器
        .fullScreenCover(item: $mediaTarget) { t in
            MediaViewerView(groups: t.groups, initialGroup: t.group, initialIndex: t.index) { mediaTarget = nil }
        }
        // 活动页、小游戏：独立原生 WebView 全屏打开，不影响大厅页（只开我们自己的网页，见 openWeb）
        .fullScreenCover(item: $webTarget) { t in
            GameWebSheet(url: t.url, title: t.title, landscape: t.landscape)
        }
        // 另开一页内嵌网页（真人认证）：大厅这个网页容器不给摄像头、也不让跳去别的网站，认证要在 HnWebPage 里做
        .fullScreenCover(item: $h5Target) { t in
            NavStack { HnWebPage(route: t.route) }
        }
        .onChange(of: webTarget?.id) { id in
            GameLog.log("hall: webTarget changed -> \(id == nil ? "nil(dismiss)" : "present \(webTarget?.url.absoluteString ?? "") landscape=\(webTarget?.landscape ?? false)")")
        }
        .task {
            guard hallUrl == nil else { return }
            struct HallCfg: Codable { var url: String? = "" }
            let cfg: HallCfg? = try? await Api.request("/modules/hall")
            var base = cfg?.url ?? ""
            // 地址后面要拼登录令牌，所以后台给的地址必须是我们自己的网页，否则当作没配
            if !base.isEmpty, !Api.isOwnWebUrl(URL(string: base)) {
                GameLog.log("hall: configured url is not our own site, ignored")
                base = ""
            }
            if base.isEmpty { base = "\(Api.baseURL)/site/#/hall-embed" }
            let sep = base.contains("?") ? "&" : "?"
            // lang：大厅网页跟 App 当前语言走（不带时网页按系统语言）
            hallUrl = URL(string: withIndexCacheBuster("\(base)\(sep)token=\(Api.token ?? "")&embed=1&lang=\(I18nStore.shared.lang)"))
            GameLog.log("hall: load url=\(base) (cfg='\(cfg?.url ?? "")')")
        }
    }
}

/// 在 hash（#）之前加 _t 时间戳：index.html 请求每次都不同，绕过 WebView 缓存的旧 index.html
/// （旧 index 引用的旧 hash 资源部署后已删除 → 黑屏）。hash 后的路由参数不受影响。
func withIndexCacheBuster(_ url: String) -> String {
    let parts = url.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
    let head = String(parts[0])
    let tail = parts.count > 1 ? "#" + String(parts[1]) : ""
    let sep = head.contains("?") ? "&" : "?"
    return "\(head)\(sep)_t=\(Int(Date().timeIntervalSince1970))\(tail)"
}

/// 大厅网页让 App 另开的那一页内嵌网页（route 是网页里 # 后面的路径）
struct H5Target: Identifiable {
    let id = UUID()
    let route: String
}

/// 原生全屏网页目标（小游戏等）；landscape 为横屏游戏（仅该页旋转）
struct WebTarget: Identifiable {
    let id = UUID()
    let url: URL
    let title: String
    var landscape: Bool = false
}

/**
 * 小游戏/大厅 WebView 调试日志：Xcode 控制台或 Console.app 搜索 "[Game]"。
 * 同时把 H5 的 console.log/error、window.onerror 通过 JS 桥转成原生日志（见 consoleForwardScript）。
 */
enum GameLog {
    static func log(_ msg: String) { NSLog("[Game] %@", msg) }

    /// 注入到 H5：console.* 与 JS 报错转发到 messageHandlers.peiwan（type=log）
    static let consoleForwardScript = WKUserScript(source: """
    (function(){
      if (window.__peiwanLogHooked) return; window.__peiwanLogHooked = true;
      function fmt(args){ return Array.prototype.map.call(args, function(a){
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.message + ' ' + (a.stack || '');
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }).join(' '); }
      function send(level, args){
        try { window.webkit.messageHandlers.peiwan.postMessage({ type: 'log', level: level, msg: fmt(args) }); } catch (e) {}
      }
      ['log','info','warn','error'].forEach(function(k){
        var orig = console[k];
        console[k] = function(){ send(k, arguments); try { orig.apply(console, arguments); } catch (e) {} };
      });
      window.addEventListener('error', function(e){ send('error', ['onerror', e.message, (e.filename||'') + ':' + e.lineno]); });
      window.addEventListener('unhandledrejection', function(e){ send('error', ['unhandledrejection', String(e.reason && (e.reason.stack || e.reason))]); });
      send('log', ['bridge ready: webkit=' + !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.peiwan)]);
    })();
    """, injectionTime: .atDocumentStart, forMainFrameOnly: true)

    /// 处理 H5 转发过来的 log 消息，返回 true 表示已消费
    static func handleLogMessage(_ body: [String: Any], scope: String) -> Bool {
        guard body["type"] as? String == "log" else { return false }
        let level = body["level"] as? String ?? "log"
        let msg = body["msg"] as? String ?? ""
        log("\(scope): [H5 \(level)] \(msg)")
        return true
    }
}

/// 页面加载 / 失败 / 进程崩溃日志（大厅页用）。整页跳转只允许去我们自己的网页，别的地址拦下不开。
final class WebNavLogger: NSObject, WKNavigationDelegate {
    let scope: String
    init(scope: String) { self.scope = scope }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // 只管整页跳转（targetFrame 为空是 window.open / target=_blank，也算）；页面里嵌的小框（iframe）不管
        let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        let scheme = navigationAction.request.url?.scheme?.lowercased() ?? ""
        if mainFrame, scheme == "http" || scheme == "https", !Api.isOwnWebUrl(navigationAction.request.url) {
            GameLog.log("\(scope): blocked navigation to a page that is not our own site: \(scheme)://\(navigationAction.request.url?.host ?? "")")
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        GameLog.log("\(scope): page started \(webView.url?.absoluteString.components(separatedBy: "token=").first ?? "")")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        GameLog.log("\(scope): page finished title='\(webView.title ?? "")'")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        GameLog.log("\(scope): load failed \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        GameLog.log("\(scope): provisional load failed \(error.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        GameLog.log("\(scope): web content process terminated (crash), reloading")
        webView.reload()
    }
}

/// 大厅 WebView 容器：深色底避免加载白闪，支持侧滑返回 H5 内页；
/// 注册 JS 桥（window.webkit.messageHandlers.peiwan）：openChat 唤起原生聊天页，openWeb 唤起原生全屏网页
/// 混合媒体项（图片 / 视频），大厅 H5 经桥传来
struct MediaItemModel: Codable, Identifiable {
    var id: String { url }
    let type: String
    let url: String
    let cover: String?
}

/// 查看器目标：所有帖子的媒体（按显示顺序）+ 点开的是第几条的第几个
struct MediaTarget: Identifiable {
    let id = UUID()
    let groups: [[MediaItemModel]]
    let group: Int
    let index: Int
}

private struct HallWebView: UIViewRepresentable {
    let url: URL
    let onOpenChat: (ChatTarget) -> Void
    let onOpenWeb: (WebTarget) -> Void
    var onViewMedia: (MediaTarget) -> Void = { _ in }
    var onOpenH5: (String) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator(onOpenChat: onOpenChat, onOpenWeb: onOpenWeb, onViewMedia: onViewMedia, onOpenH5: onOpenH5) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.userContentController.add(context.coordinator, name: "peiwan")
        // 桥版本标记：H5 据此判断 viewMedia 等新桥是否可用（老版本 App 没有这个标记就走网页灯箱）
        // __hnHallH5：这一版认识 openH5（另开一页内嵌网页），网页据此决定真人认证是交给 App 另开一页、还是在网页里跳
        config.userContentController.addUserScript(WKUserScript(source: "window.__peiwanBridgeV2=true;window.__hnHallH5=true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // H5 console / JS 报错转原生日志（[Game] hall: [H5 ...]）
        config.userContentController.addUserScript(GameLog.consoleForwardScript)
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(Theme.bg)
        web.scrollView.backgroundColor = UIColor(Theme.bg)
        web.allowsBackForwardNavigationGestures = true
        web.navigationDelegate = context.coordinator.navLogger
        GameLog.log("hall: webview created, bridge peiwan registered")
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler {
        let onOpenChat: (ChatTarget) -> Void
        let onOpenWeb: (WebTarget) -> Void
        let onViewMedia: (MediaTarget) -> Void
        let onOpenH5: (String) -> Void
        let navLogger = WebNavLogger(scope: "hall")
        init(onOpenChat: @escaping (ChatTarget) -> Void, onOpenWeb: @escaping (WebTarget) -> Void, onViewMedia: @escaping (MediaTarget) -> Void, onOpenH5: @escaping (String) -> Void) {
            self.onOpenChat = onOpenChat
            self.onOpenWeb = onOpenWeb
            self.onViewMedia = onViewMedia
            self.onOpenH5 = onOpenH5
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "peiwan" else { return }
            guard let body = message.body as? [String: Any] else {
                GameLog.log("hall: bridge message with non-dict body: \(String(describing: message.body))")
                return
            }
            if GameLog.handleLogMessage(body, scope: "hall") { return }
            GameLog.log("hall: bridge message \(body)")
            switch body["type"] as? String {
            case "openChat":
                guard let convId = body["convId"] as? String, !convId.isEmpty else { return }
                let convType = (body["convType"] as? NSNumber)?.intValue ?? Int(body["convType"] as? String ?? "") ?? 1
                let targetId = body["targetId"] as? String ?? ""
                let title = body["title"] as? String ?? ""
                let onOpenChat = onOpenChat
                // 1 = 单聊（targetId 是对方的用户 id）；2 = 群聊（约单以后进线路群，targetId 是群 id）。别的不认
                guard convType == 1 || convType == 2 else {
                    GameLog.log("hall: openChat rejected, convType=\(convType) is not supported")
                    return
                }
                DispatchQueue.main.async {
                    onOpenChat(ChatTarget(convId: convId, convType: convType, targetId: targetId, title: title))
                }
            case "openH5":
                // 另开一页内嵌网页：route 是网页里 # 后面的路径，开的一定是我们自己的网页（HnWebPage 自己拼域名）
                let route = body["route"] as? String ?? ""
                let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/_-?=&%.")
                guard route.hasPrefix("/"), route.count <= 200, route.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
                    GameLog.log("hall: openH5 rejected, bad route")
                    return
                }
                let onOpenH5 = onOpenH5
                DispatchQueue.main.async { onOpenH5(route) }
            case "openWeb":
                // 只开我们自己的网页（Api.isOwnWebUrl），别的地址不开
                guard let raw = body["url"] as? String,
                      let url = URL(string: raw),
                      Api.isOwnWebUrl(url)
                else {
                    GameLog.log("hall: openWeb rejected, url invalid or not our own site")
                    return
                }
                let title = body["title"] as? String ?? ""
                let landscape = (body["orientation"] as? String) == "landscape"
                let onOpenWeb = onOpenWeb
                DispatchQueue.main.async {
                    GameLog.log("hall: openWeb -> present GameWebSheet url=\(url.absoluteString) landscape=\(landscape)")
                    onOpenWeb(WebTarget(url: url, title: title, landscape: landscape))
                }
            case "viewMedia":
                // 新协议 groups（所有帖子）；老协议只有 items（单条）
                var groups: [[MediaItemModel]] = []
                if let raw = body["groups"], let data = try? JSONSerialization.data(withJSONObject: raw),
                   let gs = try? JSONDecoder().decode([[MediaItemModel]].self, from: data) {
                    groups = gs.filter { !$0.isEmpty }
                } else if let raw = body["items"], let data = try? JSONSerialization.data(withJSONObject: raw),
                          let items = try? JSONDecoder().decode([MediaItemModel].self, from: data), !items.isEmpty {
                    groups = [items]
                }
                guard !groups.isEmpty else { GameLog.log("hall: viewMedia bad payload"); return }
                let toInt: (Any?) -> Int = { v in (v as? NSNumber)?.intValue ?? Int(v as? String ?? "") ?? 0 }
                let g = min(max(0, toInt(body["group"])), groups.count - 1)
                let index = toInt(body["index"])
                let onViewMedia = onViewMedia
                DispatchQueue.main.async { onViewMedia(MediaTarget(groups: groups, group: g, index: index)) }
            default:
                GameLog.log("hall: unknown bridge type \(String(describing: body["type"]))")
                return
            }
        }
    }
}

/**
 * 全屏网页容器（活动页、小游戏）：独立于大厅 WebView，页面内跳转不影响大厅页。
 * - 只开我们自己的网页（`Api.isOwnWebUrl`）：进来的地址在 openWeb 那里查过，页面里整页跳去别的网站这里拦下
 * - landscape=true：仅本页旋转为横屏（App 其余页面锁竖屏，见 OrientationLock），无顶栏、隐藏状态栏，左上角浮动返回键
 * - 竖屏顶栏：返回（优先网页后退）、标题（跟随网页 title）、关闭
 * - WKWebView 按游戏场景配置：内联播放、媒体免手势自动播放、侧滑后退、弹窗（alert/confirm）转原生
 * - 非 http(s) 链接（weixin:// alipays:// 等）交给系统打开
 */
struct GameWebSheet: View {
    let url: URL
    let title: String
    var landscape: Bool = false
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = GameWebModel()

    var body: some View {
        Group {
            if landscape {
                GameWebView(url: url, model: model)
                    .ignoresSafeArea()
                    .overlay(alignment: .topLeading) {
                        Button {
                            if model.canGoBack { model.goBack() } else { dismiss() }
                        } label: {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(width: 36, height: 36)
                                .background(Color.black.opacity(0.45), in: Circle())
                        }
                        .padding(.leading, 10)
                        .padding(.top, 10)
                    }
                    .statusBarHidden(true)
            } else {
                VStack(spacing: 0) {
                    HStack(spacing: 0) {
                        Button {
                            if model.canGoBack { model.goBack() } else { dismiss() }
                        } label: {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(Theme.text)
                                .frame(width: 40, height: 40)
                        }
                        Text(model.pageTitle.isEmpty ? title : model.pageTitle)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Theme.text)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity)
                        Button(t("common.close")) { dismiss() }
                            .font(.system(size: 14))
                            .foregroundStyle(model.canGoBack ? Theme.textSub : .clear)
                            .frame(width: 56, height: 40)
                            .disabled(!model.canGoBack)
                    }
                    .padding(.horizontal, 8)
                    .background(Theme.bg)
                    .overlay(alignment: .bottom) {
                        if model.progress > 0 && model.progress < 1 {
                            GeometryReader { geo in
                                Rectangle().fill(Theme.accent)
                                    .frame(width: geo.size.width * model.progress, height: 2)
                            }
                            .frame(height: 2)
                        }
                    }
                    GameWebView(url: url, model: model)
                        .ignoresSafeArea(edges: .bottom)
                }
            }
        }
        .background(Color.black.ignoresSafeArea())
        // 进入横屏游戏时旋转屏幕，离开还原竖屏（fullScreenCover 关闭即触发）
        .onAppear {
            GameLog.log("game: sheet appear url=\(url.absoluteString) title=\(title) landscape=\(landscape)")
            if landscape { OrientationLock.set(.landscape) }
        }
        .onDisappear {
            GameLog.log("game: sheet disappear")
            if landscape { OrientationLock.set(.portrait) }
        }
    }
}

/// 游戏 WebView 状态（标题 / 进度 / 可后退），供顶栏展示与控制
final class GameWebModel: ObservableObject {
    @Published var pageTitle = ""
    @Published var progress: Double = 0
    @Published var canGoBack = false
    weak var webView: WKWebView?

    func goBack() { webView?.goBack() }
}

private struct GameWebView: UIViewRepresentable {
    let url: URL
    let model: GameWebModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // 游戏音效 / 背景音乐无需用户手势即可播放
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsPictureInPictureMediaPlayback = false
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        // 默认 UA 后追加 App 标识，游戏侧可据此识别 App 环境
        config.applicationNameForUserAgent = "PeiwanApp/iOS"
        // 游戏页 console / JS 报错转原生日志（[Game] game: [H5 ...]）
        config.userContentController.add(context.coordinator, name: "peiwan")
        config.userContentController.addUserScript(GameLog.consoleForwardScript)
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.allowsBackForwardNavigationGestures = true
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        model.webView = web
        context.coordinator.observe(web)
        GameLog.log("game: webview created, loading \(url.absoluteString)")
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        GameLog.log("game: webview dismantle")
        coordinator.stopObserving()
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "peiwan")
        uiView.stopLoading()
        // 释放游戏音频 / 定时器
        uiView.loadHTMLString("", baseURL: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let model: GameWebModel
        private var observers: [NSKeyValueObservation] = []
        init(model: GameWebModel) { self.model = model }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            if GameLog.handleLogMessage(body, scope: "game") { return }
            GameLog.log("game: bridge message ignored \(body)")
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            GameLog.log("game: page started \(webView.url?.absoluteString ?? "")")
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            GameLog.log("game: page finished title='\(webView.title ?? "")'")
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            GameLog.log("game: load failed \(error.localizedDescription)")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            GameLog.log("game: provisional load failed \(error.localizedDescription)")
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            GameLog.log("game: web content process terminated (crash)")
        }

        func observe(_ web: WKWebView) {
            observers = [
                web.observe(\.title, options: [.new]) { [weak self] w, _ in
                    let t = w.title ?? ""
                    if !t.isEmpty, !t.hasPrefix("http") { self?.model.pageTitle = t }
                },
                web.observe(\.estimatedProgress, options: [.new]) { [weak self] w, _ in
                    self?.model.progress = w.estimatedProgress
                },
                web.observe(\.canGoBack, options: [.new]) { [weak self] w, _ in
                    self?.model.canGoBack = w.canGoBack
                },
            ]
        }

        func stopObserving() {
            observers.forEach { $0.invalidate() }
            observers.removeAll()
        }

        // 非 http(s) scheme（微信 / 支付宝等）交给系统
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let u = navigationAction.request.url, let scheme = u.scheme?.lowercased() else {
                decisionHandler(.allow); return
            }
            if scheme == "http" || scheme == "https" {
                // 整页跳转只允许留在我们自己的网页里；页面里嵌的小框（iframe）不管
                let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
                if mainFrame, !Api.isOwnWebUrl(u) {
                    GameLog.log("game: blocked navigation to a page that is not our own site: \(scheme)://\(u.host ?? "")")
                    decisionHandler(.cancel)
                } else {
                    decisionHandler(.allow)
                }
            } else if scheme == "about" || scheme == "blob" || scheme == "data" {
                decisionHandler(.allow)
            } else {
                GameLog.log("game: external scheme \(u.absoluteString)")
                UIApplication.shared.open(u)
                decisionHandler(.cancel)
            }
        }

        // 页面里 window.open / target=_blank：在当前 WebView 内打开（同样只开我们自己的网页）
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.targetFrame == nil, let u = navigationAction.request.url, Api.isOwnWebUrl(u) {
                webView.load(URLRequest(url: u))
            }
            return nil
        }

        // alert / confirm / prompt 转原生弹窗（WKWebView 默认不显示）
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            present(UIAlertController(title: nil, message: message, preferredStyle: .alert), actions: [
                UIAlertAction(title: t("common.ok"), style: .default) { _ in completionHandler() },
            ], onFail: completionHandler)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            present(UIAlertController(title: nil, message: message, preferredStyle: .alert), actions: [
                UIAlertAction(title: t("common.cancel"), style: .cancel) { _ in completionHandler(false) },
                UIAlertAction(title: t("common.ok"), style: .default) { _ in completionHandler(true) },
            ], onFail: { completionHandler(false) })
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            present(alert, actions: [
                UIAlertAction(title: t("common.cancel"), style: .cancel) { _ in completionHandler(nil) },
                UIAlertAction(title: t("common.ok"), style: .default) { _ in completionHandler(alert.textFields?.first?.text) },
            ], onFail: { completionHandler(nil) })
        }

        private func present(_ alert: UIAlertController, actions: [UIAlertAction], onFail: @escaping () -> Void) {
            actions.forEach(alert.addAction)
            guard let top = Self.topController() else { onFail(); return }
            top.present(alert, animated: true)
        }

        private static func topController() -> UIViewController? {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow }
            var top = window?.rootViewController
            while let presented = top?.presentedViewController { top = presented }
            return top
        }
    }
}
