import Combine
import CoreLocation
import SwiftUI

func timeAgo(_ iso: String?) -> String {
    guard let iso, !iso.isEmpty else { return "" }
    let f1 = ISO8601DateFormatter()
    f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let f2 = ISO8601DateFormatter()
    let date = f1.date(from: iso) ?? f2.date(from: iso)
    guard let d = date else { return "" }
    let min = Int(Date().timeIntervalSince(d) / 60)
    if min < 1 { return t("time.justNow") }
    if min < 60 { return t("time.minutesAgoCompact", ["n": min]) }
    if min < 1440 { return t("time.hoursAgoCompact", ["n": min / 60]) }
    if min < 43200 { return t("time.daysAgoCompact", ["n": min / 1440]) }
    return String(iso.prefix(10))
}

func parseIsoDate(_ iso: String?) -> Date? {
    guard let iso, !iso.isEmpty else { return nil }
    let f1 = ISO8601DateFormatter()
    f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f1.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
}

func fmtTime(_ iso: String?) -> String {
    guard let d = parseIsoDate(iso) else { return "" }
    let df = DateFormatter()
    df.dateFormat = Calendar.current.isDateInToday(d) ? "HH:mm" : "MM-dd HH:mm"
    return df.string(from: d)
}

/// 图片内存缓存
enum RemoteImageCache {
    static let cache: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.countLimit = 300
        return c
    }()
}

/**
 * 远程图片：内存缓存 + 失败/取消自动重试。
 * 替代 AsyncImage（它在列表滚动中请求被取消后不会重新加载，导致头像概率性空白）。
 */
struct RemoteImage: View {
    let url: String
    @State private var image: UIImage?
    @State private var attempt = 0

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Theme.bg3
            }
        }
        // 视图出屏任务取消、回屏自动重新执行，天然解决“取消后不再加载”
        .task(id: "\(url)#\(attempt)") {
            await load()
        }
    }

    private func load() async {
        let full = Api.fullUrl(url)
        guard !full.isEmpty, let u = URL(string: full) else { return }
        if let cached = RemoteImageCache.cache.object(forKey: full as NSString) {
            if image == nil { image = cached }
            return
        }
        do {
            let (data, _) = try await URLSession.shared.data(from: u)
            if let img = UIImage(data: data) {
                RemoteImageCache.cache.setObject(img, forKey: full as NSString)
                image = img
            }
        } catch {
            // 失败（含被取消恢复后）延迟重试，最多 3 次
            if attempt < 3, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 800_000_000)
                if !Task.isCancelled { attempt += 1 }
            }
        }
    }
}

/// 圆形头像
struct AvatarView: View {
    let url: String?
    var size: CGFloat = 44
    var body: some View {
        Group {
            if let url, !url.isEmpty {
                RemoteImage(url: url)
            } else {
                Circle().fill(Theme.bg3)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }
}

/// 玫红胶囊主按钮
struct AccentButton: View {
    let title: String
    var enabled: Bool = true
    let action: () -> Void
    var body: some View {
        Button(action: { if enabled { action() } }) {
            Text(title)
                .font(.system(size: 16, weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(enabled ? AnyShapeStyle(Theme.accentGrad) : AnyShapeStyle(Theme.bg3))
                .foregroundStyle(.white)
                .clipShape(Capsule())
        }
        .disabled(!enabled)
    }
}

struct PageTitle: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 22, weight: .bold))
            .foregroundStyle(Theme.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
    }
}

struct EmptyHint: View {
    let text: String
    var body: some View {
        VStack {
            Spacer()
            Text(text).font(.subheadline).foregroundStyle(Theme.textSub)
                .multilineTextAlignment(.center).lineSpacing(8)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// 文字 Tab（无背景，选中高亮加粗）
struct TextTab: View {
    let text: String
    let selected: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: 16, weight: selected ? .bold : .regular))
                .foregroundStyle(selected ? Theme.text : Theme.textSub)
        }
        .buttonStyle(.plain)
    }
}

/// Toast 提示
struct ToastModifier: ViewModifier {
    @Binding var message: String?
    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            if let msg = message {
                Text(msg)
                    .font(.system(size: 14))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18).padding(.vertical, 10)
                    .background(Capsule().fill(Color.black.opacity(0.8)))
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .onAppear {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                            withAnimation { message = nil }
                        }
                    }
            }
        }
    }
}

extension View {
    func toast(_ message: Binding<String?>) -> some View { modifier(ToastModifier(message: message)) }
}

/// 导航路由（各 Tab 根部注册 navigationDestination）
enum Route: Hashable {
    /// 动态详情（评论）
    case moment(String)
    /// 我的动态
    case myMoments
    case editProfile
    case realname
    /// 我的邀请名片（专属网页链接 + 二维码）
    case inviteCard
    case userHome(String)
    /// 关注/粉丝列表：type = following | fans
    case followList(String)
    /// AI 红娘资料收集（「编辑资料」进这里）
    case interview
    /// 从相亲画像网页点某一项过来改那一题（改完自动回画像网页）
    case interviewEdit(String)
    /// AI 深聊（原生）：真的大模型在问，按用量花模型费
    case deep
    /// AI 红娘的网页：相亲画像（/card/me、/u/用户id）、AI 费用（/ai-fee…）。参数是网页里 # 后面的路径
    case web(String)
    /// 原来的原生对方主页（动态、评分）；从画像网页里「看 TA 的动态」进
    case userHomeNative(String)
    /// 群资料（群聊页右上角「···」进来），参数是群 id
    case groupInfo(String)
}

@ViewBuilder
func routeView(_ route: Route) -> some View {
    switch route {
    case .moment(let id): MomentDetailView(momentId: id)
    case .myMoments: MyMomentsView()
    case .editProfile: EditProfileView()
    case .realname: RealnameView()
    case .inviteCard: InviteCardView()
    // 别人的主页 = 相亲画像网页（用户 2026-11-23 定的）
    case .userHome(let id): HnWebPage(route: "/u/\(id.filter { $0.isNumber })")
    case .userHomeNative(let id): UserHomeView(userId: id)
    case .followList(let type): FollowListView(type: type)
    case .interview: InterviewView()
    case .interviewEdit(let key): InterviewView(editKey: key)
    case .deep: DeepChatView()
    case .web(let route): HnWebPage(route: route)
    case .groupInfo(let id): GroupInfoView(groupId: id)
    }
}

/// 自定义底部 tab 栏的可见性：有子页面被 push 时隐藏（计数支持多级 push）
@MainActor
final class TabBarVisibility: ObservableObject {
    static let shared = TabBarVisibility()
    @Published var depth = 0
}

private struct HideTabBarModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .onAppear { withAnimation(.easeInOut(duration: 0.15)) { TabBarVisibility.shared.depth += 1 } }
            .onDisappear { withAnimation(.easeInOut(duration: 0.15)) { TabBarVisibility.shared.depth -= 1 } }
    }
}

extension View {
    /// 每个导航栈根部调用，注册统一路由（子页面自动隐藏底部 tab 栏）。
    /// iOS15 无值路由，跳转由 RouteLink 直接携带目的页，这里无需注册。
    @ViewBuilder
    func withRoutes() -> some View {
        if #available(iOS 16.0, *) {
            navigationDestination(for: Route.self) { routeView($0).modifier(HideTabBarModifier()) }
        } else {
            self
        }
    }
}

/// 代码触发的 push：route 置非 nil 即跳转，返回后自动置回 nil
private struct RoutePushModifier: ViewModifier {
    @Binding var route: Route?
    /// 返回动画期间 route 已是 nil，目的页继续用上一次的，避免白屏一闪
    @State private var last: Route?

    func body(content: Content) -> some View {
        let active = Binding(get: { route != nil }, set: { if !$0 { route = nil } })
        if #available(iOS 16.0, *) {
            content
                .navigationDestination(isPresented: active) { destination }
                .onChange(of: route) { if let r = $0 { last = r } }
        } else {
            content
                .background(NavigationLink(isActive: active) { destination } label: { EmptyView() }.hidden())
                .onChange(of: route) { if let r = $0 { last = r } }
        }
    }

    @ViewBuilder private var destination: some View {
        if let r = route ?? last { routeView(r).modifier(HideTabBarModifier()) }
    }
}

extension View {
    func routePush(_ route: Binding<Route?>) -> some View { modifier(RoutePushModifier(route: route)) }
}

/// 路由跳转链接：iOS16 走值路由（navigationDestination），iOS15 直接挂目的页
struct RouteLink<Label: View>: View {
    let route: Route
    @ViewBuilder let label: () -> Label

    init(_ route: Route, @ViewBuilder label: @escaping () -> Label) {
        self.route = route
        self.label = label
    }

    var body: some View {
        if #available(iOS 16.0, *) {
            NavigationLink(value: route, label: label)
        } else {
            NavigationLink {
                LazyView(routeView(route).modifier(HideTabBarModifier()))
            } label: {
                label()
            }
        }
    }
}

/// 聊天全屏展示的目标（fullScreenCover）
struct ChatTarget: Identifiable {
    let id = UUID()
    let convId: String
    let convType: Int
    let targetId: String
    let title: String
    /// 搜索结果进来时定位到的消息
    var focusMsgId: String? = nil
    /// 先填进输入框的话（从互相喜欢的庆祝页点了一句开场白进来），可以改了再发
    var draft: String? = nil
}

/// 打开与某用户的单聊会话
func openChatWith(userId: String, nickname: String) async -> ChatTarget? {
    guard let r: OpenConvResp = try? await Api.request("/im/conversations/open/\(userId)", method: "POST") else { return nil }
    return ChatTarget(convId: r.conversationId, convType: 1, targetId: userId, title: nickname)
}

/// 一次性定位 + 反查城市名
final class CityLocator: NSObject, CLLocationManagerDelegate {
    static let shared = CityLocator()
    private let manager = CLLocationManager()
    private var handler: ((String?) -> Void)?

    /// 最近一次定位结果（供距离计算）
    private(set) var lastLocation: CLLocation?

    func detect(_ completion: @escaping (String?) -> Void) {
        handler = completion
        manager.delegate = self
        let status = manager.authorizationStatus
        if status == .notDetermined {
            manager.requestWhenInUseAuthorization()
        } else if status == .authorizedWhenInUse || status == .authorizedAlways {
            manager.requestLocation()
        } else {
            completion(nil); handler = nil
        }
    }

    /// 定位城市 + 经纬度
    func detectWithLocation(_ completion: @escaping (String?, CLLocation?) -> Void) {
        detect { [weak self] name in
            completion(name, self?.lastLocation)
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let s = manager.authorizationStatus
        if s == .authorizedWhenInUse || s == .authorizedAlways { manager.requestLocation() }
        else if s == .denied || s == .restricted { handler?(nil); handler = nil }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.first else { handler?(nil); handler = nil; return }
        lastLocation = loc
        CLGeocoder().reverseGeocodeLocation(loc, preferredLocale: Locale(identifier: "zh_CN")) { [weak self] placemarks, _ in
            let name = placemarks?.first?.locality ?? placemarks?.first?.administrativeArea
            self?.handler?(name?.replacingOccurrences(of: "市", with: ""))
            self?.handler = nil
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        handler?(nil); handler = nil
    }

    /// 拿一次经纬度（发送位置消息用）
    func currentLocation(_ completion: @escaping (CLLocation?, String?) -> Void) {
        detectRaw { loc in
            guard let loc else { completion(nil, nil); return }
            CLGeocoder().reverseGeocodeLocation(loc, preferredLocale: Locale(identifier: "zh_CN")) { pms, _ in
                let p = pms?.first
                let addr = [p?.locality, p?.subLocality, p?.thoroughfare, p?.name]
                    .compactMap { $0 }.joined(separator: "")
                completion(loc, addr)
            }
        }
    }

    private var rawHandler: ((CLLocation?) -> Void)?
    private func detectRaw(_ completion: @escaping (CLLocation?) -> Void) {
        handler = { _ in }
        rawHandler = completion
        manager.delegate = self
        let status = manager.authorizationStatus
        if status == .notDetermined { manager.requestWhenInUseAuthorization() }
        else if status == .authorizedWhenInUse || status == .authorizedAlways {
            if let last = manager.location { completion(last); rawHandler = nil; handler = nil; return }
            manager.requestLocation()
        } else { completion(nil); rawHandler = nil; handler = nil }
    }
}
