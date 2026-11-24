import SwiftUI

/*
 * 模块三、四：每日推荐、喜欢 / 跳过、互相喜欢后才能聊天。样稿 design/03-match.html，照着安卓的 MatchScreens.kt 写的。
 * 分法（用户 2026-11-23 定的）：
 *   原生 —— 广场 → 遇见 →「推荐」（RecSectionView）、消息页顶上的三个数字（LikeEntriesView）、
 *           聊天页的提示条和不能发的说明、互相喜欢的庆祝页（MatchCelebrationView）；
 *   网页 —— 画像网页底部的喜欢 / 跳过按钮、喜欢列表（/likes），用 HnWebPage 打开。
 * 「没有互相喜欢不能聊天」是服务器强制的，这里只负责把话说清楚。
 * 注意：iOS 没法在 Windows 上编译，这个文件没有编译验证过。
 */

// MARK: - 接口返回的数据

/// 在遇见 / 别人的画像里自己点喜欢的名额（每日推荐里的、回应对方喜欢的不占）
struct MatchQuota: Codable, Hashable {
    var limit: Int? = 3
    var used: Int? = 0
    var left: Int? = 3
}

struct MatchPeer: Codable, Hashable {
    var id: String = ""
    var nickname: String? = ""
    var avatar: String? = ""
    var gender: Int? = 0
    var age: Int? = 0
    var cityName: String? = ""
}

/// 每日推荐里的一位
struct RecItem: Codable, Hashable, Identifiable {
    var user: MatchPeer = MatchPeer()
    /// 照片下面的小标签：城市、身高、学历、职业
    var chips: [String]? = []
    /// 共同点
    var tags: [String]? = []
    /// AI 写的推荐理由；空 = 没写成（没有余额也没有 Key），只显示共同点
    var reason: String? = ""
    /// none 还没表态 | liked | passed | mutual
    var state: String? = "none"
    var likedMe: Bool? = false

    var id: String { user.id }
}

struct MatchToday: Codable {
    /// 我的基本情况填完了没有
    var ready: Bool? = false
    /// 下一批什么时候来（ISO 时间）
    var nextAt: String? = ""
    var limit: Int? = 3
    var quota: MatchQuota? = nil
    var likedMe: Int? = 0
    var list: [RecItem]? = []
}

struct NewMatch: Codable, Hashable {
    var peer: MatchPeer = MatchPeer()
    var conversationId: String = ""
}

/// 消息页顶上的三个数字 + 还没看过的互相喜欢
struct MatchSummary: Codable {
    var likedMe: Int? = 0
    var likedMeNew: Int? = 0
    var liked: Int? = 0
    var mutual: Int? = 0
    var newMatches: [NewMatch]? = []
    var quota: MatchQuota? = nil
    var ready: Bool? = false
}

/// 我和某个人的关系
struct MatchRelation: Codable {
    /// none 都没表态 | liked 我喜欢了 | likedMe 对方先喜欢了我 | mutual 互相喜欢 | ended 有一方结束了联系
    var state: String? = "none"
    var endedBy: String? = nil
    var matchedAt: String? = nil
    /// 现在能不能发消息
    var canChat: Bool? = false
    /// mutual | legacy 规则上线前的老聊天，保留期内 | need_like | legacy_expired | ended_me | ended_peer
    var chatReason: String? = "need_like"
    var legacyUntil: String? = nil
    var quota: MatchQuota? = nil
}

struct LikeResult: Codable {
    var state: String? = "liked"
    var matched: Bool? = false
    var peer: MatchPeer? = nil
    var conversationId: String? = nil
    var quota: MatchQuota? = nil
}

private struct IceResp: Codable {
    var lines: [String]? = []
}

/// 只关心成没成的接口（跳过、结束、举报、看过了）：返回里的字段都不强求
struct MatchOk: Codable {
    var ok: Bool? = nil
    var state: String? = nil
}

/// ISO 时间 → 「11 月 23 日」
func matchDayText(_ iso: String?) -> String {
    guard let d = parseIsoDate(iso) else { return "" }
    let c = Calendar.current.dateComponents([.month, .day], from: d)
    return "\(c.month ?? 0) 月 \(c.day ?? 0) 日"
}

/// 下一批推荐什么时候来：「今天上午 10 点」/「明天上午 10 点」
private func nextRecText(_ iso: String?) -> String {
    guard let d = parseIsoDate(iso) else { return "明天上午 10 点" }
    let hour = Calendar.current.component(.hour, from: d)
    return (Calendar.current.isDateInToday(d) ? "今天" : "明天") + "上午 \(hour) 点"
}

/// 不能聊天时提示的那句话
func chatBlockedText(_ reason: String?) -> String {
    switch reason {
    case "ended_peer": return "对方已结束聊天"
    case "ended_me": return "你已选择不再联系"
    case "legacy_expired": return "互相喜欢后才能继续聊"
    default: return "互相喜欢后才能聊天"
    }
}

// MARK: - 全局：庆祝页、数字刷新、点喜欢

@MainActor
final class MatchCenter: ObservableObject {
    static let shared = MatchCenter()

    /// 不是 nil 就弹出庆祝页（RootView 最上层画）
    @Published var celebrate: NewMatch?
    /// 喜欢相关的事有变化（有人喜欢我、互相喜欢、对方结束聊天、我点了喜欢）就加一：消息页的数字、底栏角标、推荐页看到它变了就重新取
    @Published var version = 0
    /// 没填完基本情况的人点了「喜欢」：RootView 弹框带去填
    @Published var needFill = false
    /// 顶上弹一下的提示（名额用完了、互相喜欢后才能聊天…）
    @Published var tip: String?

    private var listening = false

    /// 登录后调一次：监听服务器推来的喜欢相关消息，并看看有没有没看过的互相喜欢
    func start() {
        Task { await checkNew() }
        guard !listening else { return }
        listening = true
        WsClient.shared.addListener { frame in
            guard frame["op"] as? String == "match" else { return }
            let matched = frame["event"] as? String == "matched"
            Task { @MainActor in
                // 互相喜欢了 → 弹庆祝页；有人喜欢我 / 对方结束了聊天 → 让各页面重新取数字
                if matched { await MatchCenter.shared.checkNew() } else { MatchCenter.shared.version += 1 }
            }
        }
    }

    func show(peer: MatchPeer, conversationId: String) {
        celebrate = NewMatch(peer: peer, conversationId: conversationId)
        version += 1
    }

    /// 对方回了我的喜欢（服务器推了一条消息，或者我刚打开 App）：有没看过的互相喜欢就弹出来
    func checkNew() async {
        if let s: MatchSummary = try? await Api.request("/match/summary"), celebrate == nil, let first = s.newMatches?.first {
            celebrate = first
        }
        version += 1
    }

    /**
     * 点喜欢。对方早就喜欢我了 → 当场互相喜欢，顺手弹庆祝页。
     * 失败返回 nil：没填完基本情况的弹框带去填，其它的（名额用完等）顶上提示一句。
     */
    func like(_ userId: String) async -> LikeResult? {
        do {
            let r: LikeResult = try await Api.request("/match/like/\(userId)", method: "POST")
            if r.matched == true, let conv = r.conversationId, let peer = r.peer {
                show(peer: peer, conversationId: conv)
            } else {
                version += 1
            }
            return r
        } catch let e as ApiError {
            if e.reason == "need_profile" { needFill = true } else { tip = e.msg }
        } catch {
            tip = error.localizedDescription
        }
        return nil
    }
}

/**
 * 通过用户 id 打开聊天（搜索、老主页这些地方用）：互相喜欢了才能聊（规则上线前就聊过的有保留期）。
 * 不能聊的顶上提示一句、返回 nil。
 */
@MainActor
func openChatIfAllowed(userId: String, nickname: String) async -> ChatTarget? {
    if let rel: MatchRelation = try? await Api.request("/match/relation/\(userId)"), rel.canChat != true {
        MatchCenter.shared.tip = chatBlockedText(rel.chatReason)
        return nil
    }
    return await openChatWith(userId: userId, nickname: nickname)
}

// MARK: - 广场 → 遇见 → 推荐

/**
 * 每日推荐：每天几位（默认 3 位），一次看一位，喜欢或跳过后换下一位。
 * 点照片打开对方的画像网页；onBrowse 切到旁边的「所有」。
 */
struct RecSectionView: View {
    var onBrowse: () -> Void
    @ObservedObject private var center = MatchCenter.shared
    @State private var today: MatchToday?
    @State private var err = ""
    @State private var busy = false

    var body: some View {
        Group {
            if let d = today {
                ScrollView { content(d).padding(.bottom, 20) }
            } else {
                EmptyHint(text: err.isEmpty ? "正在为你挑人…" : err)
            }
        }
        // 进来取一次；从别人的画像网页回来（在那里可能点了喜欢 / 跳过）、喜欢相关的事有变化，都重新取
        .onAppear { Task { await load() } }
        .onChange(of: center.version) { _ in Task { await load() } }
    }

    private func load() async {
        do {
            let d: MatchToday = try await Api.request("/match/today")
            today = d
            err = ""
        } catch {
            if today == nil { err = (error as? ApiError)?.msg ?? "加载失败" }
        }
    }

    private func setState(_ id: String, _ state: String) {
        guard var d = today, var list = d.list, let i = list.firstIndex(where: { $0.user.id == id }) else { return }
        list[i].state = state
        d.list = list
        today = d
    }

    @ViewBuilder
    private func content(_ d: MatchToday) -> some View {
        let list = d.list ?? []
        let left = list.filter { ($0.state ?? "none") == "none" }
        if d.ready != true {
            // 基本情况没填完：不给推荐
            VStack(spacing: 0) {
                centerBlock(title: "先把基本情况填完", sub: "填完才能给你推荐，\n别人也才能在推荐里看到你。")
                RouteLink(.interview) { HnButtonLabel(title: "去填写") }
                    .buttonStyle(.plain).frame(width: 200).padding(.top, 22)
            }
        } else if list.isEmpty {
            // 一个条件对得上的人都没有：如实说
            VStack(spacing: 0) {
                centerBlock(title: "现在还没有合适的人", sub: "条件和你互相符合的人暂时还没有。\n有新的人加入，会第一时间推荐给你。")
                links(d)
            }
        } else if let cur = left.first {
            card(d, cur, left.count)
        } else {
            let liked = list.filter { $0.state == "liked" || $0.state == "mutual" }.count
            let passed = list.filter { $0.state == "passed" }.count
            VStack(spacing: 0) {
                centerBlock(title: "今天的 \(list.count) 位看完了", sub: "\(nextRecText(d.nextAt))有新的推荐\n今天喜欢了 \(liked) 位，跳过 \(passed) 位")
                links(d)
            }
        }
    }

    /// 居中的说明：看完了 / 没有人 / 没填完
    private func centerBlock(title: String, sub: String) -> some View {
        VStack(spacing: 0) {
            HnOrb(size: 60)
            Text(title).font(.system(size: 21, weight: .heavy)).foregroundStyle(HnTheme.ink).padding(.top, 28)
            Text(sub).font(.system(size: 13)).foregroundStyle(HnTheme.ink2).lineSpacing(6).multilineTextAlignment(.center).padding(.top, 8)
        }
        .padding(.horizontal, 30).padding(.top, 36)
        .frame(maxWidth: .infinity)
    }

    /// 看完以后下面的三行入口：喜欢我的、去「所有」里逛逛、和 AI 红娘再聊聊
    private func links(_ d: MatchToday) -> some View {
        VStack(spacing: 0) {
            RouteLink(.web("/likes?tab=likedMe")) {
                linkRow("heart", "喜欢我的", (d.likedMe ?? 0) > 0 ? "\(d.likedMe ?? 0) 人" : "", strong: true)
            }
            .buttonStyle(.plain)
            Button(action: onBrowse) {
                linkRow("person.2", "去「所有」里逛逛", "今天还能喜欢 \(d.quota?.left ?? 0) 个", strong: false)
            }
            .buttonStyle(.plain)
            RouteLink(.deep) {
                linkRow("sparkles", "和 AI 红娘再聊聊，让推荐更准", "", strong: false)
            }
            .buttonStyle(.plain)
        }
        .background(RoundedRectangle(cornerRadius: 22).fill(Color.white))
        .shadow(color: HnTheme.rose.opacity(0.1), radius: 10, x: 0, y: 6)
        .padding(.horizontal, 16).padding(.top, 26)
    }

    private func linkRow(_ icon: String, _ text: String, _ end: String, strong: Bool) -> some View {
        HStack(spacing: 11) {
            Image(systemName: icon).font(.system(size: 13, weight: .semibold)).foregroundStyle(HnTheme.rose)
                .frame(width: 30, height: 30)
                .background(RoundedRectangle(cornerRadius: 10).fill(HnTheme.soft))
            Text(text).font(.system(size: 15)).foregroundStyle(HnTheme.ink).lineLimit(1)
            Spacer(minLength: 4)
            if !end.isEmpty {
                Text(end).font(.system(size: strong ? 15 : 12.5, weight: strong ? .bold : .regular)).foregroundStyle(strong ? HnTheme.rose : HnTheme.ink2)
            }
            Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(HnTheme.ink3)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 50)
        .contentShape(Rectangle())
    }

    /// 当前这一位：大照片 + 为什么推荐 + ✕ / ♥
    private func card(_ d: MatchToday, _ cur: RecItem, _ leftCount: Int) -> some View {
        let list = d.list ?? []
        let ta = cur.user.gender == 1 ? "他" : "她"
        let reason = cur.reason ?? ""
        let tags = cur.tags ?? []
        return VStack(spacing: 0) {
            HStack(spacing: 5) {
                Text("今天为你挑了 \(list.count) 位").font(.system(size: 13.5, weight: .semibold)).foregroundStyle(HnTheme.ink)
                if list.count < (d.limit ?? 3) {
                    Text("合适的人还不多，有几位给几位").font(.system(size: 11)).foregroundStyle(HnTheme.ink3).lineLimit(1)
                }
                Spacer()
                ForEach(list) { x in
                    let on = x.user.id == cur.user.id
                    Capsule().fill(on ? AnyShapeStyle(HnTheme.grad) : AnyShapeStyle(HnTheme.ink.opacity(0.15)))
                        .frame(width: on ? 18 : 6, height: 6)
                }
            }
            .padding(.horizontal, 22).padding(.top, 2).padding(.bottom, 8)

            VStack(alignment: .leading, spacing: 0) {
                RouteLink(.userHome(cur.user.id)) {
                    ZStack(alignment: .bottomLeading) {
                        Color(red: 0.918, green: 0.875, blue: 0.882)
                        GeometryReader { geo in
                            RemoteImage(url: cur.user.avatar ?? "").frame(width: geo.size.width, height: geo.size.height).clipped()
                        }
                        LinearGradient(colors: [.clear, Color(red: 0.094, green: 0.031, blue: 0.055).opacity(0.82)], startPoint: .center, endPoint: .bottom)
                        VStack(alignment: .leading, spacing: 7) {
                            HStack(alignment: .lastTextBaseline, spacing: 8) {
                                Text(cur.user.nickname ?? "").font(.system(size: 25, weight: .heavy)).foregroundStyle(.white).lineLimit(1)
                                if let age = cur.user.age, age > 0 { Text("\(age)").font(.system(size: 20)).foregroundStyle(.white) }
                            }
                            HStack(spacing: 5) {
                                ForEach(cur.chips ?? [], id: \.self) { c in
                                    Text(c).font(.system(size: 11.5)).foregroundStyle(.white).lineLimit(1)
                                        .padding(.horizontal, 10).padding(.vertical, 3)
                                        .background(Capsule().fill(Color.white.opacity(0.24)))
                                        .overlay(Capsule().stroke(Color.white.opacity(0.35), lineWidth: 1))
                                }
                            }
                        }
                        .padding(.horizontal, 16).padding(.bottom, 13)
                    }
                    .frame(height: 268)
                    .clipped()
                }
                .buttonStyle(.plain)

                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 6) {
                        HnOrb(size: 26)
                        Text(reason.isEmpty ? "你和\(ta)的共同点" : "AI 红娘为什么推荐\(ta)")
                            .font(.system(size: 12.5, weight: .bold)).foregroundStyle(HnTheme.rose)
                        Spacer()
                        if !reason.isEmpty { Text("✦ AI 生成").font(.system(size: 11)).foregroundStyle(HnTheme.ink3) }
                    }
                    if !reason.isEmpty {
                        Text(reason).font(.system(size: 14.5)).foregroundStyle(HnTheme.ink).lineSpacing(6).padding(.top, 8)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if !tags.isEmpty {
                        MatchTagsRow(tags: tags).padding(.top, 10)
                    } else if reason.isEmpty {
                        Text("你们的条件互相符合。点照片看\(ta)的完整画像。").font(.system(size: 13)).foregroundStyle(HnTheme.ink2).lineSpacing(5).padding(.top, 8)
                    }
                    if cur.likedMe == true {
                        Text("\(ta)已经喜欢了你，你也喜欢的话马上就能聊天").font(.system(size: 13, weight: .semibold)).foregroundStyle(HnTheme.rose).padding(.top, 10)
                    }
                }
                .padding(EdgeInsets(top: 13, leading: 16, bottom: 15, trailing: 16))
            }
            .background(Color.white)
            .clipShape(RoundedRectangle(cornerRadius: 28))
            .shadow(color: HnTheme.rose.opacity(0.18), radius: 16, x: 0, y: 12)
            .padding(.horizontal, 16)

            // 后面还有几位：卡片下面露出两层边
            if leftCount > 1 {
                RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.7)).frame(height: 12).padding(.horizontal, 30)
            }
            if leftCount > 2 {
                RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.45)).frame(height: 9).padding(.horizontal, 46)
            }

            HStack(spacing: 26) {
                Button { pass(cur.user.id) } label: {
                    Image(systemName: "xmark").font(.system(size: 22, weight: .semibold)).foregroundStyle(HnTheme.ink2)
                        .frame(width: 62, height: 62)
                        .background(Circle().fill(Color.white))
                        .shadow(color: HnTheme.ink.opacity(0.1), radius: 10, x: 0, y: 8)
                }
                .buttonStyle(.plain).disabled(busy)
                Button { like(cur.user.id) } label: {
                    Image(systemName: "heart").font(.system(size: 28, weight: .semibold)).foregroundStyle(.white)
                        .frame(width: 72, height: 72)
                        .background(Circle().fill(HnTheme.grad))
                        .shadow(color: HnTheme.rose.opacity(0.38), radius: 13, x: 0, y: 12)
                }
                .buttonStyle(.plain).disabled(busy)
            }
            .padding(.top, 14)
            Text("点照片看\(ta)的完整画像").font(.system(size: 11)).foregroundStyle(HnTheme.ink3).padding(.top, 8)
        }
    }

    private func like(_ id: String) {
        guard !busy else { return }
        busy = true
        Task {
            if let r = await MatchCenter.shared.like(id) { setState(id, r.matched == true ? "mutual" : "liked") }
            busy = false
        }
    }

    private func pass(_ id: String) {
        guard !busy else { return }
        busy = true
        Task {
            do {
                let _: MatchOk = try await Api.request("/match/pass/\(id)", method: "POST")
                setState(id, "passed")
            } catch {
                MatchCenter.shared.tip = (error as? ApiError)?.msg ?? "操作失败"
            }
            busy = false
        }
    }
}

/// 共同点小标签，一行放不下就横着滑
struct MatchTagsRow: View {
    let tags: [String]
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(tags, id: \.self) { tag in
                    Text(tag).font(.system(size: 12, weight: .semibold)).foregroundStyle(HnTheme.rose).lineLimit(1)
                        .padding(.horizontal, 11).frame(height: 26)
                        .background(Capsule().fill(HnTheme.soft))
                }
            }
        }
    }
}

// MARK: - 消息页顶上：喜欢我的 / 我喜欢的 / 互相喜欢

/// 三个数字，点哪个进喜欢列表（网页）对应的分类
struct LikeEntriesView: View {
    let sum: MatchSummary?

    var body: some View {
        HStack(spacing: 10) {
            entry("likedMe", "喜欢我的", sum?.likedMe)
            entry("liked", "我喜欢的", sum?.liked)
            entry("mutual", "互相喜欢", sum?.mutual)
        }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
    }

    private func entry(_ key: String, _ label: String, _ n: Int?) -> some View {
        RouteLink(.web("/likes?tab=\(key)")) {
            VStack(spacing: 2) {
                Text(n.map { "\($0)" } ?? "-").font(.system(size: 20, weight: .heavy))
                    .foregroundStyle(key == "likedMe" && (n ?? 0) > 0 ? HnTheme.rose : HnTheme.ink)
                Text(label).font(.system(size: 12)).foregroundStyle(HnTheme.ink2)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 20).fill(Color.white))
            .shadow(color: HnTheme.rose.opacity(0.1), radius: 8, x: 0, y: 5)
            // 有新喜欢我的人：右上角红点
            .overlay(alignment: .topTrailing) {
                if key == "likedMe", (sum?.likedMeNew ?? 0) > 0 {
                    Circle().fill(HnTheme.rose).frame(width: 8, height: 8).padding(.top, 8).padding(.trailing, 10)
                }
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 互相喜欢的庆祝页

/**
 * 两边都点了喜欢的那一刻弹出，盖在主界面上面（RootView 里画）。
 * onChat：进你们的聊天；draft 是点了 AI 想的某一句开场白，先填进输入框，可以改了再发。
 */
struct MatchCelebrationView: View {
    let match: NewMatch
    let myAvatar: String
    var onChat: (ChatTarget) -> Void
    @State private var lines: [String] = []

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 1.0, green: 0.541, blue: 0.431), HnTheme.rose, Color(red: 1.0, green: 0.42, blue: 0.42), Color(red: 0.839, green: 0.157, blue: 0.416)],
                startPoint: .top, endPoint: .bottom
            )
            .ignoresSafeArea()
            ScrollView {
                VStack(spacing: 0) {
                    Text("互相喜欢了").font(.system(size: 30, weight: .heavy)).kerning(2).foregroundStyle(.white)
                    Text("你和\(match.peer.nickname ?? "")都喜欢了对方，现在可以聊天了")
                        .font(.system(size: 14)).foregroundStyle(Color.white.opacity(0.92)).multilineTextAlignment(.center).padding(.top, 8)
                    ZStack {
                        HStack(spacing: 24) {
                            duo(myAvatar)
                            duo(match.peer.avatar ?? "")
                        }
                        Image(systemName: "heart").font(.system(size: 22, weight: .semibold)).foregroundStyle(HnTheme.rose)
                            .frame(width: 52, height: 52)
                            .background(Circle().fill(Color.white))
                            .shadow(color: Color.black.opacity(0.2), radius: 9, x: 0, y: 6)
                    }
                    .padding(.top, 26)

                    if !lines.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text("✦ AI 红娘帮你想的开场白").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white)
                                Spacer()
                                Text("AI 生成 · 点一句带进聊天").font(.system(size: 11)).foregroundStyle(Color.white.opacity(0.8))
                            }
                            ForEach(lines, id: \.self) { line in
                                Button { go(line) } label: {
                                    Text(line).font(.system(size: 13.5)).foregroundStyle(HnTheme.ink).lineSpacing(4)
                                        .multilineTextAlignment(.leading)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.horizontal, 12).padding(.vertical, 9)
                                        .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.92)))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(EdgeInsets(top: 13, leading: 14, bottom: 14, trailing: 14))
                        .background(RoundedRectangle(cornerRadius: 22).fill(Color.white.opacity(0.18)))
                        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.white.opacity(0.4), lineWidth: 1))
                        .padding(.top, 24)
                    }

                    Button { go("") } label: {
                        Text("开始聊天").font(.system(size: 16, weight: .bold)).foregroundStyle(HnTheme.rose)
                            .frame(maxWidth: .infinity).frame(height: 50)
                            .background(Capsule().fill(Color.white))
                            .shadow(color: Color.black.opacity(0.2), radius: 12, x: 0, y: 10)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 22)
                    Button { MatchCenter.shared.celebrate = nil } label: {
                        Text("待会儿再说").font(.system(size: 14)).foregroundStyle(Color.white.opacity(0.9)).padding(12)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 6)
                }
                .padding(.horizontal, 26).padding(.top, 70).padding(.bottom, 24)
            }
        }
        .task(id: match.peer.id) {
            lines = []
            // 看过了，下次不再弹
            let _: MatchOk? = try? await Api.request("/match/seen/\(match.peer.id)", method: "POST")
            // 开场白：有余额或 Key 才有，没有就不显示这一块
            if let r: IceResp = try? await Api.request("/match/icebreakers/\(match.peer.id)", method: "POST") { lines = r.lines ?? [] }
        }
    }

    private func duo(_ url: String) -> some View {
        ZStack {
            Circle().fill(Color(red: 0.953, green: 0.776, blue: 0.812))
            if !url.isEmpty { RemoteImage(url: url) }
        }
        .frame(width: 110, height: 110)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color.white, lineWidth: 4))
        .shadow(color: Color.black.opacity(0.22), radius: 14, x: 0, y: 12)
    }

    private func go(_ draft: String) {
        MatchCenter.shared.celebrate = nil
        onChat(ChatTarget(convId: match.conversationId, convType: 1, targetId: match.peer.id, title: match.peer.nickname ?? "", draft: draft.isEmpty ? nil : draft))
    }
}

// MARK: - 小号的喜欢按钮：老主页这些原来放「聊天 / 发消息」的地方用

/**
 * 没表态 →「♥ 喜欢」；我喜欢了 →「已喜欢」；对方先喜欢了我 →「♥ 也喜欢」；互相喜欢 →「发消息」。
 * 有一方结束了联系就不显示。
 */
struct LikeChipView: View {
    let userId: String
    let nickname: String
    var height: CGFloat = 34
    /// 撑满父容器的宽度
    var wide = false
    var onChat: (ChatTarget) -> Void
    @ObservedObject private var center = MatchCenter.shared
    @State private var state: String?
    @State private var busy = false

    var body: some View {
        Group {
            if let s = state, s != "ended" {
                let ghost = s == "liked"
                Button { tap(s) } label: {
                    Text(s == "mutual" ? "发消息" : s == "liked" ? "✓ 已喜欢" : s == "likedMe" ? "♥ 也喜欢" : "♥ 喜欢")
                        .font(.system(size: height > 40 ? 15 : 13, weight: .semibold))
                        .foregroundStyle(ghost ? HnTheme.ink2 : Color.white)
                        .lineLimit(1)
                        .padding(.horizontal, height > 40 ? 24 : 16)
                        .frame(maxWidth: wide ? .infinity : nil)
                        .frame(height: height)
                        .background(Capsule().fill(ghost ? AnyShapeStyle(Color.white) : AnyShapeStyle(HnTheme.grad)))
                        .shadow(color: (ghost ? HnTheme.ink3 : HnTheme.rose).opacity(0.28), radius: 5, x: 0, y: 3)
                }
                .buttonStyle(.plain)
                .disabled(busy)
            }
        }
        .task(id: "\(userId)#\(center.version)") {
            if let r: MatchRelation = try? await Api.request("/match/relation/\(userId)") { state = r.state ?? "none" }
        }
    }

    private func tap(_ s: String) {
        if s == "liked" || busy { return }
        busy = true
        Task {
            if s == "mutual" {
                if let target = await openChatWith(userId: userId, nickname: nickname) { onChat(target) }
            } else if let r = await MatchCenter.shared.like(userId) {
                state = r.state ?? state
            }
            busy = false
        }
    }
}

// MARK: - 聊天页用的几样

/// 聊天页顶上的提示条：哪天配上的 + 防骗提醒；老聊天写明保留到哪天
struct ChatMatchBanner: View {
    let rel: MatchRelation?

    private var text: String? {
        guard let rel else { return nil }
        if rel.state == "mutual" {
            return (rel.matchedAt != nil ? "你们在 \(matchDayText(rel.matchedAt))互相喜欢了。" : "你们互相喜欢了。") + "\n线下见面前不要转账，遇到借钱、投资的请直接举报。"
        }
        if rel.chatReason == "legacy" {
            return "现在要互相喜欢才能聊天。你们以前聊过，\(matchDayText(rel.legacyUntil))前还能照常聊；到那天还没互相喜欢，就不能再发新消息了（聊天记录还在）。"
        }
        return nil
    }

    var body: some View {
        if let text {
            Text(text).font(.system(size: 12.5)).foregroundStyle(HnTheme.ink2).lineSpacing(4).multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 16).fill(Color.black.opacity(0.04)))
                .padding(.horizontal, 14).padding(.top, 6).padding(.bottom, 2)
        }
    }
}

/// 不能发消息时，输入区换成的那一句说明（聊天记录照常能看）
struct ChatBlockedBar: View {
    let rel: MatchRelation
    var onOpenCard: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Text(chatBlockedText(rel.chatReason) + (rel.state == "liked" && rel.endedBy == nil ? "。你已经喜欢了 TA，等 TA 回应" : ""))
                .font(.system(size: 14)).foregroundStyle(HnTheme.ink2).multilineTextAlignment(.center)
            if rel.endedBy == nil, rel.state != "liked" {
                Button(action: onOpenCard) {
                    HnPillLabel(title: rel.state == "likedMe" ? "TA 喜欢了你，去看看" : "去 TA 的画像点喜欢")
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16).padding(.vertical, 14)
        .background(Color(red: 0.969, green: 0.957, blue: 0.961).ignoresSafeArea(edges: .bottom))
    }
}

/// 举报一个人的原因（聊天页右上角「举报」用 confirmationDialog 列出来）
let reportUserReasons = ["资料或照片是假的", "骚扰、辱骂", "借钱、投资、要转账", "发广告或引流", "色情低俗", "其他"]

/// 提交举报，返回一句提示
func reportUser(_ userId: String, reason: String) async -> String {
    do {
        let _: MatchOk = try await Api.request("/match/report/\(userId)", method: "POST", body: ["reason": reason])
        return "举报已提交，平台会尽快核实"
    } catch {
        return (error as? ApiError)?.msg ?? "提交失败"
    }
}
