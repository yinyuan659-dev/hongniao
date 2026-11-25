import SwiftUI
import UIKit

// MARK: - Emoji 数据

/// 一组 emoji：items 每项 [emoji, 中文名, 关键词]
struct EmojiGroup: Codable, Identifiable, Hashable {
    var key: String
    var name: String
    var icon: String
    var items: [[String]] = []
    var id: String { key }
}

private struct EmojiResp: Codable {
    var version: Int? = 0
    var notModified: Bool? = false
    var groups: [EmojiGroup]? = []
}

/// Unicode emoji 分类数据（后端 /emojis，UserDefaults 缓存按 version 增量）+ 最近使用
@MainActor
final class EmojiStore: ObservableObject {
    static let shared = EmojiStore()
    @Published var groups: [EmojiGroup] = []
    @Published var recent: [String] = (UserDefaults.standard.array(forKey: "emoji_recent") as? [String]) ?? []
    private var version = 0
    private var fetched = false

    private init() {
        version = UserDefaults.standard.integer(forKey: "emoji_version")
        if let data = UserDefaults.standard.data(forKey: "emoji_groups"), let g = try? JSONDecoder().decode([EmojiGroup].self, from: data) { groups = g }
    }

    func ensureLoaded() async {
        if fetched && !groups.isEmpty { return }
        let path = version > 0 ? "/emojis?ver=\(version)" : "/emojis"
        guard let r: EmojiResp = try? await Api.request(path) else { return }
        fetched = true
        if r.notModified == true, !groups.isEmpty { return }
        guard let g = r.groups, !g.isEmpty else { return }
        version = r.version ?? 0
        groups = g
        UserDefaults.standard.set(version, forKey: "emoji_version")
        if let data = try? JSONEncoder().encode(groups) { UserDefaults.standard.set(data, forKey: "emoji_groups") }
    }

    func addRecent(_ e: String) {
        recent = ([e] + recent.filter { $0 != e }).prefix(32).map { $0 }
        UserDefaults.standard.set(recent, forKey: "emoji_recent")
    }

    /// 关键词搜索（中英文，空格分词全部命中）
    func search(_ q: String, limit: Int = 120) -> [String] {
        let words = q.trimmingCharacters(in: .whitespaces).lowercased().split(separator: " ").map(String.init).filter { !$0.isEmpty }
        if words.isEmpty { return [] }
        var out: [String] = []
        for g in groups {
            for it in g.items {
                let hay = ((it.count > 1 ? it[1] : "") + " " + (it.count > 2 ? it[2] : "")).lowercased()
                if words.allSatisfy({ hay.contains($0) || it[0] == $0 }) {
                    out.append(it[0])
                    if out.count >= limit { return out }
                }
            }
        }
        return out
    }
}

/// 删掉字符串末尾一个「用户看到的字符」（emoji 可能由多个码点 + ZWJ 组成；Swift 的 Character 就是字素簇）
func dropLastGrapheme(_ s: String) -> String {
    s.isEmpty ? s : String(s.dropLast())
}

/// 记住键盘高度：面板要跟键盘差不多高
@MainActor
final class KeyboardHeight: ObservableObject {
    static let shared = KeyboardHeight()
    @Published var last: CGFloat = CGFloat(UserDefaults.standard.double(forKey: "kb_height"))
    private var token: NSObjectProtocol?

    private init() {
        token = NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] n in
            guard let f = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue, f.height > 200 else { return }
            Task { @MainActor in
                self?.last = f.height
                UserDefaults.standard.set(Double(f.height), forKey: "kb_height")
            }
        }
    }

    /// 面板高度（去掉底部安全区；没记录过用 336）
    var panelHeight: CGFloat {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let bottom = scene?.windows.first?.safeAreaInsets.bottom ?? 0
        let h = last > 0 ? last - bottom : 336
        return min(440, max(320, h))
    }
}

// MARK: - 面板壳

/// 内容区滚动方向 → 顶部条 / 底部胶囊收起或展开（往下滚收起，往上滚或回到顶部展开）
/// 不标 @MainActor：由 ScrollTrackerView 的 KVO 回调（主线程）直接调用
final class PanelChrome: ObservableObject {
    @Published var hidden = false
    /// 锚点：展开时跟着最低点走，收起时跟着最高点走（见 onOffset）
    private var anchor: CGFloat = 0
    /// 上次切换时间：切换后顶部条高度变了，ScrollView 会重排、offset 抖一下，这段时间内的变化不算
    private var lastToggle: CFTimeInterval = 0

    /**
     top = 已滚过的距离（往下滚为正），maxTop = 能滚到的最大值（超出即在底部回弹）。
     Telegram 手感，用「锚点」而不是逐帧方向（手指抖动、120Hz 小步都不怕）：
     展开状态下锚点跟着最低点走，比锚点再往下 24pt 就收；收起状态下锚点跟着最高点走，比锚点往上 40pt 才展开（收比展容易）。
     回到顶部 12pt 内一定展开；底部回弹阶段和刚切换后的 300ms 内忽略。
     */
    func onOffset(top: CGFloat, maxTop: CGFloat) {
        if top < 12 { anchor = top; set(false); return }
        if top > maxTop + 1 { anchor = min(top, maxTop); return }
        if CACurrentMediaTime() - lastToggle < 0.3 { anchor = top; return }
        if !hidden {
            if top < anchor { anchor = top }
            if top - anchor > 24 { set(true) }
        } else {
            if top > anchor { anchor = top }
            if anchor - top > 40 { set(false) }
        }
    }

    private func set(_ h: Bool) {
        guard hidden != h else { return }
        hidden = h
        lastToggle = CACurrentMediaTime()
    }
}

/**
 滚动跟踪（一个 pane 一个）：从宿主 UIScrollView 直读 contentOffset（KVO），一次回调干两件事：
 1. 喂给 `PanelChrome.onOffset` 做顶部条 / 底部按钮的收起判定；
 2. **分区高亮**：分区标题下面挂一个 `SectionAnchor`（隐形 UIView），位置用 UIKit `convert` 算——之前用 GeometryReader(.global) + PreferenceKey，
    滚动时每帧改值、每帧走一遍整棵树的 preference 归约再回调 `onPreferenceChange`，是滚动卡顿的固定开销之一；
    懒加载销毁掉的标题位置也记着（内容坐标不随滚动变），滚到一个大分区中间时仍能算对。
 */
final class ScrollTracker: ObservableObject {
    @Published var active: String
    /// 分区标题在滚动内容坐标里的 y（含已被 LazyVStack 销毁的）
    private var positions: [String: CGFloat] = [:]
    /// 当前还在层级里的标题锚点
    private var anchors: [String: WeakView] = [:]
    /// 点封面跳分区时：先手动置 active，动画滚动过程中不要被途经的分区抢走
    private var holdUntil: CFTimeInterval = 0

    private struct WeakView { weak var view: UIView? }

    init(active: String) { self.active = active }

    fileprivate func register(_ key: String, _ v: UIView) {
        anchors[key] = WeakView(view: v)
        if let sv = hostScrollView(of: v) { positions[key] = v.convert(CGPoint.zero, to: sv).y }
    }

    fileprivate func unregister(_ key: String) { anchors[key] = nil }

    /// 手动指定当前分区（点封面），0.6 秒内不让滚动过程改写
    func select(_ key: String) {
        holdUntil = CACurrentMediaTime() + 0.6
        if active != key { active = key }
    }

    /// 宿主 UIScrollView 每次 contentOffset 变化都会来一次（主线程，每帧）
    fileprivate func offsetChanged(_ sv: UIScrollView) {
        refreshActive(sv)
    }

    private func refreshActive(_ sv: UIScrollView) {
        for (k, a) in anchors {
            if let v = a.view, v.window != nil { positions[k] = v.convert(CGPoint.zero, to: sv).y } else { anchors[k] = nil }
        }
        guard !positions.isEmpty, CACurrentMediaTime() >= holdUntil else { return }
        let top = sv.contentOffset.y + sv.adjustedContentInset.top
        // 标题顶到可视区顶部 8pt 以内的最靠下的那个；一个都没过顶（还在最上面）就取最靠上的
        var best: (String, CGFloat)?, first: (String, CGFloat)?
        for (k, y) in positions {
            if y - top <= 8, best.map({ y > $0.1 }) ?? true { best = (k, y) }
            if first.map({ y < $0.1 }) ?? true { first = (k, y) }
        }
        if let k = (best ?? first)?.0, k != active { active = k }
    }

    fileprivate static func hostScrollView(of v: UIView) -> UIScrollView? {
        var cur: UIView? = v.superview
        while let c = cur, !(c is UIScrollView) { cur = c.superview }
        return cur as? UIScrollView
    }

    private func hostScrollView(of v: UIView) -> UIScrollView? { ScrollTracker.hostScrollView(of: v) }
}

/**
 滚动偏移观察：塞进 ScrollView 内容里的一个隐形 UIView，挂到窗口后沿 superview 找到宿主 UIScrollView，KVO 它的 contentOffset。
 之前用 GeometryReader + 命名坐标系 + preference 那套，在真机上不回调（顶部条 / 胶囊从来不收），改用 UIKit 直读最稳。
 onOffset 参数 = (已滚过的距离（往下滚为正）, 最大可滚距离)，同时通知 tracker。
 */
private struct ScrollTrackerView: UIViewRepresentable {
    let tracker: ScrollTracker
    var onOffset: (CGFloat, CGFloat) -> Void

    func makeUIView(context: Context) -> ObserverView {
        let v = ObserverView()
        v.tracker = tracker
        v.onOffset = onOffset
        v.isUserInteractionEnabled = false
        v.backgroundColor = .clear
        return v
    }

    func updateUIView(_ v: ObserverView, context: Context) {
        v.tracker = tracker
        v.onOffset = onOffset
    }

    final class ObserverView: UIView {
        weak var tracker: ScrollTracker?
        var onOffset: ((CGFloat, CGFloat) -> Void)?
        private var obs: NSKeyValueObservation?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            obs = nil
            guard window != nil else { return }
            // 等这一轮布局结束再找，刚挂上时 superview 链可能还没接到 UIScrollView
            DispatchQueue.main.async { [weak self] in self?.attach() }
        }

        private func attach() {
            guard let sv = ScrollTracker.hostScrollView(of: self) else { return }
            obs = sv.observe(\.contentOffset, options: [.new]) { [weak self] sv, _ in
                guard let self else { return }
                let inset = sv.adjustedContentInset
                let top = sv.contentOffset.y + inset.top
                let maxTop = max(0, sv.contentSize.height + inset.top + inset.bottom - sv.bounds.height)
                self.onOffset?(top, maxTop)
                self.tracker?.offsetChanged(sv)
            }
        }
    }
}

/// 分区标题的锚点：挂在标题 `.background` 上的隐形 UIView，进层级就到 tracker 报到、出层级注销（位置由 tracker 用 convert 读）
private struct SectionAnchor: UIViewRepresentable {
    let key: String
    let tracker: ScrollTracker

    func makeUIView(context: Context) -> AnchorView {
        let v = AnchorView()
        v.key = key
        v.tracker = tracker
        v.isUserInteractionEnabled = false
        v.backgroundColor = .clear
        return v
    }

    func updateUIView(_ v: AnchorView, context: Context) {
        if v.key != key {
            v.tracker?.unregister(v.key)
            v.key = key
            if v.window != nil { tracker.register(key, v) }
        }
        v.tracker = tracker
    }

    static func dismantleUIView(_ v: AnchorView, coordinator: ()) { v.tracker?.unregister(v.key) }

    final class AnchorView: UIView {
        var key = ""
        weak var tracker: ScrollTracker?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil {
                // 等布局完再报到，这时 frame 才是真的
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.window != nil else { return }
                    self.tracker?.register(self.key, self)
                }
            } else {
                tracker?.unregister(key)
            }
        }
    }
}

/// 搜索行右侧的快捷 emoji（Telegram 同款）：点了带着它去搜
private let quickEmojis = ["❤️", "👍", "👎", "🎉", "👋", "😀", "😢", "😠"]

/// 底部表情搜索 sheet 请求。query 是从搜索行带进来的词（"" 只聚焦搜索框，emoji 直接带着搜）
private struct SheetReq: Identifiable {
    var query: String
    var id: String { query }
}

/**
 表情面板（Telegram 式，三端同一套）：内容往下滚时底部按钮和顶部条一起收起。
 点了插进输入框（onEmoji），左 🌐 切回键盘（onKeyboard），右 ⌫ 删一个字（onDelete）
 */
struct EmojiPanel: View {
    var onEmoji: ((String) -> Void)? = nil
    var onDelete: (() -> Void)? = nil
    var onKeyboard: (() -> Void)? = nil

    @StateObject private var chrome = PanelChrome()
    @ObservedObject private var kb = KeyboardHeight.shared
    @State private var sheet: SheetReq? = nil

    var body: some View {
        ZStack(alignment: .bottom) {
            EmojiPane(chrome: chrome, onEmoji: pickEmoji, onSearch: { q in sheet = SheetReq(query: q) })
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            // 底部悬浮：左 🌐 / 右 ⌫
            HStack {
                if let onKeyboard {
                    sideBtn(action: onKeyboard) { Image(systemName: "globe").font(.system(size: 18)) }
                } else {
                    Color.clear.frame(width: 40, height: 40)
                }
                Spacer()
                if let onDelete {
                    sideBtn(action: onDelete) { Image(systemName: "delete.left").font(.system(size: 17)) }
                } else {
                    Color.clear.frame(width: 40, height: 40)
                }
            }
            .padding(.horizontal, 12).padding(.bottom, 10)
            .offset(y: chrome.hidden ? 70 : 0)
            .opacity(chrome.hidden ? 0 : 1)
            .allowsHitTesting(!chrome.hidden)
            .animation(.easeInOut(duration: 0.2), value: chrome.hidden)
        }
        .frame(height: kb.panelHeight)
        .background(Theme.bg2)
        .clipped()
        .sheet(item: $sheet) { r in
            EmojiSearchSheet(initialQuery: r.query, onEmoji: pickEmoji)
        }
    }

    private func pickEmoji(_ e: String) {
        onEmoji?(e)
        EmojiStore.shared.addRecent(e)
    }

    private func sideBtn<C: View>(action: @escaping () -> Void, @ViewBuilder content: () -> C) -> some View {
        Button(action: action) {
            content()
                .foregroundStyle(Theme.text)
                .frame(width: 40, height: 40)
                .background(Circle().fill(Theme.bg).shadow(color: .black.opacity(0.14), radius: 6, y: 2))
                .overlay(Circle().stroke(Theme.line, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 公共小件

/// 顶部条上的一个格子（图标 / 封面），expanded 时下面带名字
private struct BarCell<C: View>: View {
    var active: Bool
    var expanded: Bool
    var title: String
    var badge = false
    var action: () -> Void
    @ViewBuilder var content: () -> C

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                ZStack(alignment: .topTrailing) {
                    content().frame(width: 30, height: 30)
                    if badge {
                        Text("+").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
                            .frame(width: 14, height: 14).background(Circle().fill(Theme.accent))
                            .offset(x: 4, y: -3)
                    }
                }
                if expanded {
                    Text(title).font(.system(size: 10)).foregroundStyle(Theme.textSub).lineLimit(1).frame(maxWidth: 54)
                }
            }
            .frame(width: expanded ? 56 : 40, height: expanded ? 64 : 40)
            .background(RoundedRectangle(cornerRadius: 10).fill(active ? Theme.bg3 : Color.clear))
        }
        .buttonStyle(.plain)
    }
}

/**
 搜索行（Telegram 图）：一整条圆角胶囊，左边 🔍「搜索」，右边一排**虚化**的快捷 emoji。
 - 传 onTap：整条胶囊是个按钮（弹搜索 sheet 并聚焦搜索框），点快捷 emoji 直接带着它去搜；
 - 不传：点胶囊变成输入框就地搜，快捷 emoji 点亮一个当过滤词。
 */
private struct SearchRow: View {
    @Binding var text: String
    @Binding var chip: String
    var placeholder: String
    var onTap: (() -> Void)? = nil

    @FocusState private var focused: Bool
    private var editing: Bool { onTap == nil && (focused || !text.isEmpty) }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.textDim)
            if onTap != nil {
                Text(placeholder).font(.system(size: 14)).foregroundStyle(Theme.textDim)
            } else {
                TextField(placeholder, text: $text).font(.system(size: 14)).foregroundStyle(Theme.text)
                    .focused($focused)
                    .frame(width: editing ? nil : 44)
            }
            if editing {
                Spacer(minLength: 0)
                Image(systemName: "xmark").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    .frame(width: 26, height: 26).contentShape(Rectangle())
                    .onTapGesture { text = ""; chip = ""; focused = false }
            } else {
                Spacer(minLength: 4)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 2) {
                        ForEach(quickEmojis, id: \.self) { e in
                            let on = chip == e
                            Text(e).font(.system(size: 19))
                                .frame(width: 30, height: 30)
                                .background(Circle().fill(on ? Theme.bg : Color.clear))
                                // 虚化：灰度 + 半透明，被选中的那个恢复彩色
                                .grayscale(on ? 0 : 1)
                                .opacity(on ? 1 : 0.45)
                                .contentShape(Rectangle())
                                .onTapGesture { chip = on ? "" : e }
                        }
                    }
                }
                .frame(maxWidth: 8 * 32)
            }
        }
        .padding(.leading, 12).padding(.trailing, 6).frame(height: 32)
        .background(Capsule().fill(Theme.bg3))
        .contentShape(Capsule())
        .onTapGesture { if let onTap { onTap() } else { focused = true } }
        .padding(.horizontal, 10).padding(.top, 4).padding(.bottom, 8)
        .frame(height: 44)
    }
}

private func sectionTitle(_ title: String) -> some View {
    Text(title.uppercased()).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textSub).lineLimit(1)
}

private func emptyText(_ t: String) -> some View {
    Text(t).font(.system(size: 13)).foregroundStyle(Theme.textDim).frame(maxWidth: .infinity).padding(.vertical, 24)
}

/// 顶部横向条被用户拖动时展开成两行（图 5），松手 1.5 秒后收回
private final class BarExpand: ObservableObject {
    @Published var expanded = false
    private var task: Task<Void, Never>?
    func touch() {
        expanded = true
        task?.cancel()
        task = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if !Task.isCancelled { self?.expanded = false }
        }
    }
    func collapse() { task?.cancel(); expanded = false }
}

private func baseEmoji(_ e: String) -> String { e.replacingOccurrences(of: "\u{FE0F}", with: "") }

/// 一行网格内容，id = "分区key-行号"，保证 LazyVStack 里全局唯一
private struct GridRow<T>: Identifiable {
    var id: String
    var index: Int
    var items: [T]
}

private func chunkRows<T>(_ items: [T], cols: Int, key: String) -> [GridRow<T>] {
    stride(from: 0, to: items.count, by: cols).enumerated().map { i, start in
        GridRow(id: "\(key)-r\(i)", index: i, items: Array(items[start..<min(start + cols, items.count)]))
    }
}

// MARK: - 表情页

/// 表情页：顶部 🕒 + 8 个分类图标，搜索行，内容 8 列按分类分区。
/// 搜索行整条是按钮：弹搜索 sheet（onSearch("") 聚焦输入框；点快捷 emoji 带着它去搜）。
/// 网格不用 LazyVGrid 嵌在 LazyVStack 里（嵌套后失去懒加载，1800 多个 emoji 一次建完，往下滑会卡死），改成每 8 个一行、行作为 LazyVStack 的元素。
private struct EmojiPane: View {
    @ObservedObject var chrome: PanelChrome
    var onEmoji: (String) -> Void
    var onSearch: (String) -> Void

    @ObservedObject private var store = EmojiStore.shared
    @StateObject private var bar = BarExpand()
    @StateObject private var tracker = ScrollTracker(active: "recent")
    @State private var jumpTarget: String? = nil
    @State private var noText = ""
    @State private var chipTap = ""

    private var active: String { tracker.active }

    var body: some View {
        VStack(spacing: 0) {
            if !chrome.hidden {
                VStack(spacing: 0) {
                    ScrollViewReader { proxy in
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 2) {
                                BarCell(active: active == "recent", expanded: bar.expanded, title: t("emoji.recent"), action: { jump("recent") }) {
                                    Image(systemName: "clock").font(.system(size: 18)).foregroundStyle(Theme.textSub)
                                }.id("recent")
                                ForEach(store.groups) { g in
                                    BarCell(active: active == g.key, expanded: bar.expanded, title: g.name, action: { jump(g.key) }) {
                                        Text(g.icon).font(.system(size: 20)).opacity(active == g.key ? 1 : 0.6)
                                    }.id(g.key)
                                }
                            }
                            .padding(.horizontal, 6).padding(.vertical, 6)
                        }
                        .simultaneousGesture(DragGesture(minimumDistance: 8).onChanged { _ in bar.touch() })
                        .onChange(of: active) { k in withAnimation { proxy.scrollTo(k, anchor: .center) } }
                    }
                    .frame(height: bar.expanded ? 76 : 52)
                    .animation(.easeInOut(duration: 0.15), value: bar.expanded)
                    SearchRow(text: $noText, chip: $chipTap, placeholder: t("emoji.searchEmoji"), onTap: { onSearch("") })
                        .onChange(of: chipTap) { e in if !e.isEmpty { chipTap = ""; onSearch(e) } }
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }

            ScrollViewReader { proxy in
                ScrollView {
                    ScrollTrackerView(tracker: tracker) { top, maxTop in chrome.onOffset(top: top, maxTop: maxTop) }.frame(height: 1)
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if !store.recent.isEmpty {
                            header("recent", t("emoji.recent"))
                            EmojiRows(items: store.recent, key: "recent", onEmoji: onEmoji)
                        }
                        ForEach(store.groups) { g in
                            header(g.key, g.name)
                            EmojiRows(items: g.items.map { $0[0] }, key: g.key, onEmoji: onEmoji)
                        }
                        if store.groups.isEmpty { emptyText(t("common.loading")) }
                        Color.clear.frame(height: 64)
                    }
                }
                .onChange(of: jumpTarget) { t in
                    guard let t else { return }
                    withAnimation { proxy.scrollTo("h-\(t)", anchor: .top) }
                    jumpTarget = nil
                }
            }
        }
        .animation(.easeInOut(duration: 0.18), value: chrome.hidden)
        .task { await store.ensureLoaded() }
    }

    private func header(_ key: String, _ title: String) -> some View {
        sectionTitle(title)
            .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .id("h-\(key)")
            .background(SectionAnchor(key: key, tracker: tracker))
    }

    private func jump(_ key: String) {
        bar.collapse()
        tracker.select(key)
        jumpTarget = key
    }
}

/// emoji 网格：每 8 个一行，每行是 LazyVStack 的一个元素（真正懒加载）；最后一行不满用空格子补齐保持等宽。行 id 带分区 key 防撞
private struct EmojiRows: View {
    let items: [String]
    var key: String
    var onEmoji: (String) -> Void
    private let cols = 8

    var body: some View {
        ForEach(chunkRows(items, cols: cols, key: key)) { row in
            HStack(spacing: 0) {
                ForEach(Array(row.items.enumerated()), id: \.offset) { _, e in
                    Text(e).font(.system(size: 26))
                        .frame(maxWidth: .infinity).frame(height: 42)
                        .contentShape(Rectangle())
                        .onTapGesture { onEmoji(e) }
                }
                if row.items.count < cols {
                    ForEach(0..<(cols - row.items.count), id: \.self) { _ in Color.clear.frame(maxWidth: .infinity).frame(height: 42) }
                }
            }
            .padding(.horizontal, 6)
        }
    }
}

// MARK: - 搜索 sheet

/// 搜索 sheet 外壳：顶部搜索框（自动聚焦）+「完成」，一行快捷 emoji（点了当搜索词），下面放结果
private struct SearchSheetShell<Content: View>: View {
    var placeholder: String
    @Binding var query: String
    var autoFocus = true
    @ViewBuilder var content: () -> Content
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Theme.textDim)
                    TextField(placeholder, text: $query).font(.system(size: 15)).foregroundStyle(Theme.text).focused($focused)
                    if !query.isEmpty {
                        Image(systemName: "xmark.circle.fill").font(.system(size: 14)).foregroundStyle(Theme.textDim).onTapGesture { query = "" }
                    }
                }
                .padding(.horizontal, 10).frame(height: 36)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                Button(t("common.done")) { dismiss() }.font(.system(size: 16)).foregroundStyle(Theme.accent)
            }
            .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 6)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(quickEmojis, id: \.self) { e in
                        let on = baseEmoji(query.trimmingCharacters(in: .whitespaces)) == baseEmoji(e)
                        Text(e).font(.system(size: 22))
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(on ? Theme.bg3 : Color.clear))
                            .grayscale(on ? 0 : 1).opacity(on ? 1 : 0.5)
                            .contentShape(Rectangle())
                            .onTapGesture { query = on ? "" : e }
                    }
                }
                .padding(.horizontal, 12)
            }
            .frame(height: 40)
            content()
        }
        .background(Theme.bg.ignoresSafeArea())
        .onAppear { if autoFocus { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { focused = true } } }
    }
}

/// 表情搜索 sheet：按中英文关键词 / emoji 本身搜；点了插进输入框，sheet 不关（可连续点几个），「完成」收起
struct EmojiSearchSheet: View {
    var initialQuery: String
    var onEmoji: (String) -> Void
    @ObservedObject private var store = EmojiStore.shared
    @State private var q = ""

    private var query: String { q.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        // 打开时不自动弹键盘：先看最近使用 / 快捷 emoji，要搜再点输入框
        SearchSheetShell(placeholder: t("emoji.searchEmoji"), query: $q, autoFocus: false) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    let results = query.isEmpty ? store.recent : store.search(query)
                    if query.isEmpty, !store.recent.isEmpty { sectionTitle(t("emoji.recent")).padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 4) }
                    if results.isEmpty {
                        emptyText(query.isEmpty ? t("emoji.searchHint") : t("emoji.noMatch"))
                    } else {
                        EmojiRows(items: results, key: "q", onEmoji: onEmoji)
                    }
                    Color.clear.frame(height: 30)
                }
            }
        }
        .onAppear { q = initialQuery }
        .task { await store.ensureLoaded() }
    }
}
