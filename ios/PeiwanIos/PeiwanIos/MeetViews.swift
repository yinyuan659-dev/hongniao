import SwiftUI

/// 遇见列表用户卡片（/user/meet/list）
struct MeetUser: Codable, Identifiable, Hashable {
    var id: String = ""
    var nickname: String? = ""
    var avatar: String? = ""
    var gender: Int? = 0
    var age: Int? = 0
    var cityName: String? = ""
    var isGuide: Bool? = false
    var realnameVerified: Bool? = false
    /// 0-100 平均分，显示时 /20 换算五星
    var ratingAvg: Int? = 0
    var ratingCount: Int? = 0
    /// 对方打开了视频见面（默认关）
    var allowVideo: Bool? = false
    var online: Bool? = false
    var busy: Bool? = false
    /// 注册 7 天内
    var isNew: Bool? = false
    /// 与我的亲密度分（0.5 粒度）
    var intimacy: Double? = 0
    /// none 都没表态 | liked 我喜欢了 | likedMe 对方喜欢了我 | mutual 互相喜欢
    var like: String? = "none"
}

/// 主页「遇见」：最前面是每日推荐（RecSectionView），后面是异性用户卡片流。
/// 子栏：推荐 / 所有 / 新人 / 同城 / 亲密度（亲密度按互动记分倒序）。
struct MeetSectionView: View {
    let city: String
    @EnvironmentObject private var appState: AppState
    @ObservedObject private var center = MatchCenter.shared
    /// rec = 每日推荐，排在最前面，点「遇见」先看到它
    @State private var tab = "rec"
    @State private var items: [MeetUser] = []
    @State private var loading = false
    /// 在这几个列表里自己点喜欢的名额（每天几个，后台可调；「推荐」里的不占）
    @State private var quota: MatchQuota?

    var body: some View {
        VStack(spacing: 0) {
            // 子栏胶囊：推荐 / 所有 / 新人 / 同城 / 亲密度
            HStack(spacing: 8) {
                ForEach([("rec", "推荐"), ("all", t("meet.tabAll")), ("new", t("meet.tabNew")), ("city", t("meet.tabCity")), ("intimacy", t("meet.tabIntimacy"))], id: \.0) { k, label in
                    let sel = tab == k
                    Button {
                        tab = k
                        Task { await load() }
                    } label: {
                        Text(label)
                            .font(.system(size: 13, weight: sel ? .bold : .regular))
                            .foregroundStyle(sel ? .white : Theme.textSub)
                            .lineLimit(1).fixedSize()
                            .padding(.horizontal, 13).padding(.vertical, 6)
                            .background(Capsule().fill(sel ? AnyShapeStyle(Theme.accent) : AnyShapeStyle(Theme.bg2)))
                    }
                    .buttonStyle(.plain)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16).padding(.bottom, 10)

            if tab == "rec" {
                RecSectionView(onBrowse: { tab = "all" })
            } else if items.isEmpty {
                EmptyHint(text: emptyText)
            } else {
                ScrollView {
                    if let q = quota {
                        Text("点 ♥ 喜欢，对方也喜欢你才能聊天 · 今天还能喜欢 \(q.left ?? 0) 个")
                            .font(.system(size: 12)).foregroundStyle(Theme.textSub)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 18).padding(.bottom, 8)
                    }
                    let cols = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
                    LazyVGrid(columns: cols, spacing: 10) {
                        ForEach(items) { u in
                            MeetCardView(u: u, showIntimacy: tab == "intimacy", onHeart: { heart(u) })
                        }
                    }
                    .padding(.horizontal, 12).padding(.bottom, 12)
                }
                .refreshable { await load() }
            }
        }
        .task(id: tab) {
            await load()
            // 在线/占线状态兜底：30 秒静默刷新
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                await load()
            }
        }
        // 在别人的画像网页里点了喜欢回来、喜欢相关的事有变化：卡片上的 ♥ 和名额重新取
        .onAppear { Task { await load() } }
        .onChange(of: center.version) { _ in Task { await load() } }
    }

    /// 点卡片上的 ♥：没喜欢过就喜欢（占每天的名额）；已经喜欢过的不动（取消喜欢、发消息在对方的画像里）
    private func heart(_ u: MeetUser) {
        if u.like == "liked" || u.like == "mutual" { return }
        Task {
            guard let r = await MatchCenter.shared.like(u.id) else { return }
            if let i = items.firstIndex(where: { $0.id == u.id }) { items[i].like = r.state }
            if let q = r.quota { quota = q }
        }
    }

    private var emptyText: String {
        if loading { return t("common.loading") }
        switch tab {
        case "intimacy": return t("meet.emptyIntimacy")
        case "city": return t("meet.emptyCity", ["city": city.isEmpty ? t("meet.tabCity") : city])
        default: return t("meet.empty")
        }
    }

    private func load() async {
        // 「推荐」那一格自己取数据（RecSectionView）
        if tab == "rec" { return }
        if let s: MatchSummary = try? await Api.request("/match/summary") { quota = s.quota }
        loading = items.isEmpty
        var q = "?tab=\(tab)"
        if tab == "city", !city.isEmpty {
            q += "&city=\(city.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? city)"
        }
        if let fresh: [MeetUser] = try? await Api.request("/user/meet/list\(q)") {
            items = fresh
        }
        loading = false
    }
}

/// 遇见卡片：大图 + 徽章 + 底部信息浮层
struct MeetCardView: View {
    let u: MeetUser
    var showIntimacy = false
    /// 点右上角的 ♥
    var onHeart: () -> Void = {}
    @EnvironmentObject private var appState: AppState

    var body: some View {
        let liked = u.like == "liked" || u.like == "mutual"
        return RouteLink(.userHome(u.id)) {
            ZStack {
                GeometryReader { geo in
                    RemoteImage(url: u.avatar ?? "")
                        .frame(width: geo.size.width, height: geo.size.height)
                        .clipped()
                }
                // 顶部：徽章 + 在线点，右上角是喜欢按钮（实心 = 我已经喜欢了）；对方先喜欢了我的，下面多一个小标签
                VStack {
                    HStack(alignment: .top) {
                        if u.isGuide == true || u.realnameVerified == true {
                            badge(t("meet.verified"), bg: Theme.accent)
                        } else if u.isNew == true {
                            badge(t("meet.tabNew"), bg: Color(red: 0.42, green: 0.36, blue: 0.91))
                        }
                        Circle()
                            .fill(u.online == true ? Theme.success : Theme.textDim)
                            .frame(width: 8, height: 8)
                            .padding(.top, 4)
                        Spacer()
                        VStack(alignment: .trailing, spacing: 4) {
                            Image(systemName: liked ? "heart.fill" : "heart")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(liked ? Color.white : HnTheme.rose)
                                .frame(width: 34, height: 34)
                                .background(Circle().fill(liked ? AnyShapeStyle(HnTheme.grad) : AnyShapeStyle(Color.white.opacity(0.9))))
                                .onTapGesture { onHeart() }
                            if u.like == "likedMe" { badge("喜欢了你", bg: Theme.accent) }
                        }
                    }
                    .padding(8)
                    Spacer()
                }
                // 底部信息浮层（渐变压暗保证可读）
                VStack {
                    Spacer()
                    VStack(alignment: .leading, spacing: 5) {
                        Text(u.nickname ?? "")
                            .font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                            .lineLimit(1)
                        HStack(spacing: 6) {
                            // 评分五星换算（0-100 → 5.0）
                            Text("★ \((u.ratingCount ?? 0) > 0 ? String(format: "%.1f", Double(u.ratingAvg ?? 0) / 20.0) : t("meet.ratingNew"))")
                                .font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.warn.opacity(0.85)))
                            if let c = u.cityName, !c.isEmpty {
                                Text(c).font(.system(size: 11)).foregroundStyle(.white.opacity(0.75)).lineLimit(1)
                            }
                            Spacer()
                            trailingBadge
                        }
                    }
                    .padding(.horizontal, 10).padding(.top, 26).padding(.bottom, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(LinearGradient(colors: [.clear, .black.opacity(0.8)], startPoint: .top, endPoint: .bottom))
                }
            }
            .aspectRatio(3 / 4, contentMode: .fit)
            .background(Theme.bg2)
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var trailingBadge: some View {
        if showIntimacy, let s = u.intimacy, s > 0 {
            Text("♥ \(s.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(s)) : String(format: "%.1f", s))")
                .font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.accent.opacity(0.9)))
        } else if u.allowVideo == true {
            // 视频按钮（对方打开了视频见面才有）三态：通话中 / 离线置灰 / 可打
            let busyOrange = Color(red: 1, green: 0.67, blue: 0.24)
            Text(u.busy == true ? t("meet.busy") : t("common.video"))
                .font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(u.busy == true ? busyOrange.opacity(0.9) : u.online == true ? Theme.accent : Theme.textDim.opacity(0.8)),
                )
                .onTapGesture {
                    guard u.busy != true, u.online == true else { return }
                    startCallWithPermissions(calleeId: u.id, type: 2, name: u.nickname ?? "", avatar: u.avatar ?? "")
                }
        }
    }

    private func badge(_ text: String, bg: Color) -> some View {
        Text(text)
            .font(.system(size: 10)).foregroundStyle(.white)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(bg))
    }
}
