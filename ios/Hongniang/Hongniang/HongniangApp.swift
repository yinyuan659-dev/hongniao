import Combine
import CoreLocation
import SwiftUI

/// 屏幕方向控制：全 App 默认锁竖屏（工程 Info 虽列了横屏，实际以此处返回值为准），
/// 仅横屏小游戏页临时放开为横屏（离开还原）
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    static var orientationMask: UIInterfaceOrientationMask = .portrait

    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        AppDelegate.orientationMask
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        KeyboardDismisser.shared.start()
        return true
    }
}

/**
 * 全局「点空白处收起键盘」：给 App 自己的每个 UIWindow（主窗口、通话悬浮窗）挂一个不拦截触摸的 tap 手势，
 * 点到的位置不是文本输入（UITextField / UITextView / WKWebView 内容）时 endEditing。
 * 所有 SwiftUI 页面（含 sheet / fullScreenCover）都在同一个 window 里，一处生效全 App 生效。
 */
@MainActor
final class KeyboardDismisser: NSObject, UIGestureRecognizerDelegate {
    static let shared = KeyboardDismisser()
    private let attached = NSHashTable<UIWindow>.weakObjects()

    func start() {
        NotificationCenter.default.addObserver(self, selector: #selector(onWindowVisible(_:)), name: UIWindow.didBecomeVisibleNotification, object: nil)
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .forEach(attach)
    }

    @objc private func onWindowVisible(_ n: Notification) {
        guard let w = n.object as? UIWindow else { return }
        attach(w)
    }

    private func attach(_ window: UIWindow) {
        // 系统键盘 / 文本特效窗口绝不能挂（否则点键盘本身就把键盘收了）
        let cls = NSStringFromClass(type(of: window))
        guard !cls.hasPrefix("UIRemoteKeyboard"), !cls.hasPrefix("UITextEffects"), !cls.hasPrefix("_") else { return }
        guard !attached.contains(window) else { return }
        attached.add(window)
        let tap = UITapGestureRecognizer(target: self, action: #selector(onTap(_:)))
        tap.cancelsTouchesInView = false
        tap.delaysTouchesEnded = false
        tap.delegate = self
        window.addGestureRecognizer(tap)
    }

    @objc private func onTap(_ g: UITapGestureRecognizer) {
        guard g.state == .ended, let window = g.view as? UIWindow else { return }
        var v = window.hitTest(g.location(in: window), with: nil)
        while let cur = v {
            // 点在输入框自己（或 WKWebView 网页内容，其内部 view 也实现 UIKeyInput）上：不处理，交给系统
            if cur is UIKeyInput { return }
            v = cur.superview
        }
        window.endEditing(true)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        true
    }
}

@MainActor
enum OrientationLock {
    /// 切换允许的方向并立即请求系统旋转到目标方向
    static func set(_ mask: UIInterfaceOrientationMask) {
        AppDelegate.orientationMask = mask
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        NSLog("[Game] orientation: set mask=%@ scenes=%d", mask == .portrait ? "portrait" : "landscape", scenes.count)
        if #available(iOS 16.0, *) {
            for scene in scenes {
                scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in }
                scene.windows.forEach { window in
                    var top = window.rootViewController
                    while let presented = top?.presentedViewController { top = presented }
                    top?.setNeedsUpdateOfSupportedInterfaceOrientations()
                    window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
                }
            }
        } else {
            let target: UIInterfaceOrientation = mask == .portrait ? .portrait : .landscapeRight
            UIDevice.current.setValue(target.rawValue, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }
}

@main
struct HongniangApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        // 图片/资源 HTTP 缓存：内存 64MB + 磁盘 512MB（AsyncImage 走 URLSession.shared 命中此缓存）
        URLCache.shared = URLCache(
            memoryCapacity: 64 * 1024 * 1024,
            diskCapacity: 512 * 1024 * 1024
        )
        // iOS15 没有 toolbarBackground，用全局导航栏外观兜底
        setupCompatNavBarAppearance()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.light)
        }
    }
}

enum AppStage {
    case boot
    case register
    case main
}

// 显式 @MainActor：工程开了默认 MainActor 隔离（SWIFT_DEFAULT_ACTOR_ISOLATION），
// 部分 Xcode 26.x 版本对隐式推断的类型会误报 "does not conform to ObservableObject"
@MainActor
final class AppState: ObservableObject {
    @Published var stage: AppStage = .boot
    @Published var user: UserProfile?
    /// 注册完直接弹出 AI 红娘资料收集（RootView 监听）
    @Published var openInterview = false
}

struct RootView: View {
    @StateObject private var state = AppState()
    @ObservedObject private var callManager = CallManager.shared
    @ObservedObject private var i18n = I18n.shared
    @ObservedObject private var matchCenter = MatchCenter.shared
    @ObservedObject private var deviceCenter = DeviceCenter.shared
    /// 庆祝页里点了「开始聊天」要打开的聊天
    @State private var matchChat: ChatTarget?
    /// 「你的账号在新设备登录了」里点了「不是我，去移除」：打开登录设备页（网页）
    @State private var showDevices = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            switch state.stage {
            case .boot: BootView()
            case .register: RegisterView()
            // 换语言后整棵主界面重建，所有 t() 文字一起换
            case .main: MainTabView().id(i18n.choice)
            }
            // 互相喜欢的庆祝页：盖在主界面（含 push 出来的子页面）上面。
            // 当时正开着全屏弹层（比如正在别的聊天里）的话，等弹层关掉就能看到
            if state.stage == .main, let m = matchCenter.celebrate {
                MatchCelebrationView(match: m, myAvatar: state.user?.avatar ?? "") { matchChat = $0 }
                    .transition(.opacity)
                    .zIndex(50)
            }
            // 通话界面由 CallWindow（独立 UIWindow）承载，可盖住任何弹层
            // 版本更新弹框（强制时不可关闭）
            UpdateOverlay().zIndex(99)
        }
        .animation(.easeOut(duration: 0.2), value: matchCenter.celebrate)
        // 喜欢相关的提示（名额用完了、互相喜欢后才能聊天…）
        .toast($matchCenter.tip)
        // 没填完基本情况的人点了「喜欢」
        .alert("先把基本情况填完", isPresented: $matchCenter.needFill) {
            Button("去填写") { state.openInterview = true }
            Button("以后再说", role: .cancel) {}
        } message: {
            Text("填完才能喜欢别人，别人也才能在推荐里看到你。")
        }
        // 庆祝页点「开始聊天」/ 某一句开场白：进你们的聊天
        .fullScreenCover(item: $matchChat) { target in
            ChatRoomSheet(target: target).environmentObject(state)
        }
        // 有新设备通过刷脸登录了这个账号：提醒一次；「不是我」→ 去登录设备页移除
        .alert("你的账号在新设备登录了", isPresented: Binding(
            get: { state.stage == .main && deviceCenter.alert != nil },
            set: { if !$0 { deviceCenter.alert = nil } }
        )) {
            Button("是我本人") { deviceCenter.alert = nil }
            Button("不是我，去移除") { deviceCenter.alert = nil; showDevices = true }
        } message: {
            Text("一台\(deviceCenter.alert?.name ?? "新设备")通过刷脸登录了你的账号。\n是你本人换了手机：不用管，两台都能用。\n不是你：马上移除那台设备。")
        }
        .fullScreenCover(isPresented: $showDevices) {
            NavStack {
                HnWebPage(route: "/devices")
            }
            .environmentObject(state)
        }
        // 这台设备已被移除
        .toast($deviceCenter.tip)
        // 登录身份换了（刷脸找回成功、并号进了原来的账号、本机被移除）：断开聊天连接，回启动页重新进入一次
        .onReceive(NotificationCenter.default.publisher(for: .hnSessionChanged)) { _ in
            WsClient.shared.close()
            showDevices = false
            state.user = nil
            state.stage = .boot
        }
        .task { await UpdateChecker.shared.check() }
        // 评分完成后留在/进入女方个人主页
        .fullScreenCover(isPresented: Binding(
            get: { callManager.openUserHome != nil },
            set: { if !$0 { callManager.openUserHome = nil } }
        )) {
            NavStack {
                UserHomeView(userId: callManager.openUserHome ?? "")
                    .withRoutes()
            }
            .environmentObject(state)
        }
        // 注册完直接进 AI 红娘资料收集（关掉就是主页）
        .fullScreenCover(isPresented: $state.openInterview) {
            InterviewSheet().environmentObject(state)
        }
        .environmentObject(state)
        .onChange(of: state.stage) { stage in
            // 登录后初始化通话信令监听
            if stage == .main, let user = state.user {
                WsClient.shared.connect()
                CallManager.shared.start(userId: user.id, gender: user.gender)
                // 喜欢相关的实时消息 + 有没有没看过的互相喜欢
                MatchCenter.shared.start()
                // 登录设备相关的实时消息（新设备登录、本机被移除）
                DeviceCenter.shared.start()
            }
        }
        .onChange(of: scenePhase) { phase in
            // 回前台立即重连 IM（后台 socket 可能被系统挂起断开）
            if phase == .active, state.stage == .main {
                WsClient.shared.connect()
            }
        }
        .task {
            // GPS 每分钟上报一次（用于距离展示）
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                guard state.stage == .main else { continue }
                CityLocator.shared.detectWithLocation { _, loc in
                    guard let loc else { return }
                    Task {
                        struct OkResp: Codable { var ok: Bool? }
                        let _: OkResp? = try? await Api.request("/user/location", method: "POST", body: [
                            "latitude": loc.coordinate.latitude,
                            "longitude": loc.coordinate.longitude,
                        ])
                    }
                }
            }
        }
    }
}
