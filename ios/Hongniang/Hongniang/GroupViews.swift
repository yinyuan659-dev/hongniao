import SwiftUI

/*
 * 群聊在 iOS 端共用的类型、小零件和群资料页（样稿 design/12-group.html，用户 2026-11-27 过关）。
 * 对着安卓 GroupScreens.kt、网页 web/src/group.tsx + pages/GroupInfo.tsx 写的，行为要和它们一致。
 * 规则都在后端（houduan/src/im/group.service.ts）：只有线路群和活动群，进群只能从「约单 / 参与」；只有群主和成员两种人。
 * 群的变化服务器都会推 { op: "group", data: { event, groupId, conversationId, group, userId?, nickname? } }，页面拿 group 直接改，不轮询。
 * 消息列表里群的那一行、群聊页在 ChatViews.swift（单聊、群聊共用，convType == 2 就是群聊，这时 targetId 是群 id）。
 * 注意：这个文件是在 Windows 上写的，没法编译，没有编译验证过。
 */

struct GroupMemberView: Codable, Hashable, Identifiable {
    var id: String = ""
    var nickname: String? = nil
    var avatar: String? = nil
    var gender: Int? = nil
    /// owner 群主 | member 成员
    var role: String? = nil
    var joinedAt: String? = nil
}

/// 群的信息。三个地方来的都用这一个类型：
///   消息列表（GET /im/conversations 群那一行的 group）：带 state、role，不带公告和成员；
///   群资料（GET /im/group/:id）：全都带；
///   推送（op: "group" 里的 group）：只有群本身的信息，不带 state / role / muted / members（见 merged）。
/// 除了 id 都写成可空的：服务器哪一处少给一项也不至于整条解析失败。用的时候取下面那几个带默认值的。
struct GroupInfo: Codable, Hashable {
    var id: String = ""
    var name: String? = nil
    var avatar: String? = nil
    /// trip 旅行线路的群 | event 相亲活动的群 | test 后台建的测试群
    var kind: String? = nil
    var refId: String? = nil
    var ownerId: String? = nil
    /// 0 正常 1 已解散 2 被平台关闭
    var status: Int? = nil
    var memberCount: Int? = nil
    var memberLimit: Int? = nil
    var notice: String? = nil
    var conversationId: String? = nil
    /// 活动开始 / 行程结束的时间；过了以后提示「N 天后自动解散」
    var endAt: String? = nil
    var expireAt: String? = nil
    /// 我和这个群的关系：ok 正常 | left 我退出了 | kicked 我被移出了 | dissolved 群解散了 | closed 群被平台关闭
    var state: String? = nil
    var role: String? = nil
    var muted: Bool? = nil
    /// 群主排第一；已经不在群里的人拿到的是空名单
    var members: [GroupMemberView]? = nil

    var nameText: String { name ?? "" }
    var kindText: String { kind ?? "test" }
    var noticeText: String { notice ?? "" }
    var stateText: String { state ?? "ok" }
    var count: Int { memberCount ?? 0 }
    var isOwner: Bool { role == "owner" }
    var memberList: [GroupMemberView] { members ?? [] }
}

/// 推送来的 { op: "group" } 帧里的 data
struct GroupEvent: Codable {
    /// create / join / leave / kick / info / dissolved / closed / reopen
    var event: String? = nil
    var groupId: String? = nil
    var conversationId: String? = nil
    var group: GroupInfo
    /// 进群 / 退群 / 被移出的是谁
    var userId: String? = nil
    var nickname: String? = nil
}

/// 从 WebSocket 帧里取出群的推送；不是这种帧或者格式不对返回 nil
func groupEventOf(_ frame: [String: Any]) -> GroupEvent? {
    guard let data = frame["data"] as? [String: Any],
          let json = try? JSONSerialization.data(withJSONObject: data) else { return nil }
    return try? JSONDecoder().decode(GroupEvent.self, from: json)
}

/// 群主在这种群里叫什么
func ownerLabel(_ kind: String) -> String {
    switch kind {
    case "trip": return "领队"
    case "event": return "发起人"
    default: return "群主"
    }
}

/// 群名后面的小标签
func kindLabel(_ kind: String) -> String {
    switch kind {
    case "trip": return "旅行"
    case "event": return "活动"
    default: return "测试"
    }
}

/// 群里中间那行灰色小字（消息类型 sys，内容是 {k, text}）
func sysText(_ content: String) -> String {
    guard let obj = try? JSONSerialization.jsonObject(with: Data(content.utf8)) as? [String: Any] else { return "" }
    return obj["text"] as? String ?? ""
}

/// 群用不了时，输入框换成的那句话
func groupEndText(_ state: String) -> String {
    switch state {
    case "dissolved": return "这个群已解散"
    case "closed": return "这个群因违规已被平台关闭"
    default: return "你已不在这个群里"
    }
}

/// 服务器拒绝时带的原因（error 帧的 code、接口报错的 reason）→ 群的状态；不是群的原因返回 nil
func groupReasonState(_ code: String?) -> String? {
    switch code {
    case "group_left": return "left"
    case "group_dissolved": return "dissolved"
    case "group_closed": return "closed"
    default: return nil
    }
}

/// 推送里的群信息 + 这件事说的是不是我 → 我现在的状态（推送里的 group 不带 state，要自己算）
func stateAfter(_ ev: GroupEvent, myId: String, prev: String?) -> String {
    let byStatus: String
    switch ev.group.status ?? 0 {
    case 1: byStatus = "dissolved"
    case 2: byStatus = "closed"
    default: byStatus = "ok"
    }
    if let uid = ev.userId, !uid.isEmpty, uid == myId {
        switch ev.event ?? "" {
        case "leave": return "left"
        case "kick": return "kicked"
        case "join": return byStatus
        default: break
        }
    }
    if prev == "left" || prev == "kicked" { return prev ?? byStatus }
    return byStatus
}

extension GroupInfo {
    /// 把推送里的群信息盖到现有的上面：我的状态自己算；我的身份、免打扰、成员名单推送里没有，留着原来的
    func merged(_ ev: GroupEvent, myId: String) -> GroupInfo {
        var next = ev.group
        next.state = stateAfter(ev, myId: myId, prev: state)
        next.role = role
        next.muted = muted
        next.members = members
        return next
    }
}

/// 活动 / 行程已经结束、群还没解散的那几天，输入框上面的提示。不用提示时返回 nil
func expireTip(_ g: GroupInfo, now: Date = Date()) -> String? {
    guard let end = parseIsoDate(g.endAt), let expire = parseIsoDate(g.expireAt) else { return nil }
    let left = expire.timeIntervalSince(now)
    if end > now || left <= 0 { return nil }
    let head: String
    switch g.kindText {
    case "trip": head = "行程已结束"
    case "event": head = "活动已结束"
    default: head = "已到结束时间"
    }
    let after: String
    if left >= 86400 {
        after = " \(Int((left / 86400).rounded(.up))) 天后"
    } else if left >= 3600 {
        after = " \(Int((left / 3600).rounded(.up))) 小时后"
    } else {
        after = "不到 1 小时后"
    }
    return "\(head)，这个群\(after)自动解散"
}

extension Notification.Name {
    /// 退出了 / 从列表里删掉了某个群（object 是群 id）：这个群的聊天页收到后把自己关掉，回到消息列表
    static let hnGroupExit = Notification.Name("hnGroupExit")
    /// 聊天页关掉了：消息列表和底部「消息」上的数字重新取一次（读过的消息不该还算未读）
    static let hnChatClosed = Notification.Name("hnChatClosed")
}

// MARK: - 小零件

/// 群头像：方的圆角（人是圆的，一眼分得出）。有封面用封面，没有按类型画一个默认的
struct GroupAvatar: View {
    let avatar: String?
    let kind: String
    var size: CGFloat = 54

    private var colors: [Color] {
        switch kind {
        case "trip":
            return [Color(red: 0.239, green: 0.420, blue: 0.561), Color(red: 0.498, green: 0.655, blue: 0.722),
                    Color(red: 0.851, green: 0.780, blue: 0.639), Color(red: 0.541, green: 0.416, blue: 0.290)]
        case "event":
            return [Color(red: 0.184, green: 0.365, blue: 0.314), Color(red: 0.435, green: 0.627, blue: 0.478), Color(red: 0.812, green: 0.890, blue: 0.706)]
        default:
            return [Color(red: 0.420, green: 0.435, blue: 0.561), Color(red: 0.663, green: 0.678, blue: 0.784)]
        }
    }

    private var icon: String {
        switch kind {
        case "trip": return "car.fill"
        case "event": return "leaf.fill"
        default: return "person.2.fill"
        }
    }

    var body: some View {
        ZStack {
            LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom)
            if let avatar, !avatar.isEmpty {
                RemoteImage(url: avatar)
            } else {
                Image(systemName: icon).font(.system(size: size * 0.38, weight: .medium)).foregroundStyle(Color.white)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.3))
    }
}

/// 群名后面的「旅行 / 活动」小标签
struct KindTag: View {
    let kind: String

    private var bg: Color {
        switch kind {
        case "trip": return Color(red: 0.902, green: 0.941, blue: 0.969)
        case "event": return Color(red: 0.898, green: 0.957, blue: 0.910)
        default: return Color(red: 0.933, green: 0.933, blue: 0.953)
        }
    }

    private var fg: Color {
        switch kind {
        case "trip": return Color(red: 0.184, green: 0.400, blue: 0.565)
        case "event": return Color(red: 0.184, green: 0.490, blue: 0.290)
        default: return Color(red: 0.420, green: 0.435, blue: 0.561)
        }
    }

    var body: some View {
        Text(kindLabel(kind)).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(fg).lineLimit(1).fixedSize()
            .padding(.horizontal, 7).frame(height: 18)
            .background(Capsule().fill(bg))
    }
}

/// 昵称后面的红色小标：领队 / 发起人
struct OwnerBadge: View {
    let kind: String

    var body: some View {
        Text(ownerLabel(kind)).font(.system(size: 10, weight: .bold)).foregroundStyle(Color.white).lineLimit(1).fixedSize()
            .padding(.horizontal, 5).frame(height: 15)
            .background(Capsule().fill(HnTheme.rose))
    }
}

/// 群用不了了（我退出了 / 被移出了 / 群解散了 / 被平台关闭）：输入区换成一句话，没有别的按钮；之前的聊天记录照常能看
struct GroupEndBar: View {
    let state: String

    var body: some View {
        VStack(spacing: 2) {
            Text(groupEndText(state)).font(.system(size: 14)).foregroundStyle(HnTheme.ink2).multilineTextAlignment(.center)
            if state == "left" || state == "kicked" {
                Text("之前的聊天记录还能看").font(.system(size: 12)).foregroundStyle(HnTheme.ink3)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16).padding(.vertical, 14)
        .background(Color(red: 0.969, green: 0.957, blue: 0.961).ignoresSafeArea(edges: .bottom))
    }
}

/// 活动 / 行程已经结束、群还没解散的那几天：输入框上面一条提示，照常能发
struct GroupExpireTip: View {
    let text: String

    var body: some View {
        Text(text).font(.system(size: 12.5)).foregroundStyle(Color(red: 0.604, green: 0.357, blue: 0.0)).multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color(red: 1.0, green: 0.957, blue: 0.851)))
            .padding(.horizontal, 12).padding(.top, 8)
    }
}

// MARK: - 群资料页

/// 确认框里要问的一件事
private struct GroupConfirm {
    let title: String
    let message: String
    let ok: String
    let run: () -> Void
}

/// 服务器只回 { ok: true } 的那几个接口
private struct GroupOkResp: Codable {
    var ok: Bool? = nil
    var muted: Bool? = nil
}

/// 群资料（样稿 design/12-group.html 第 2 组）。
/// 普通成员：成员、群公告（只能看）、消息免打扰、举报这个群、退出群聊。
/// 群主（线路群是领队，活动群是发起人）：多了改群名、写群公告、移出成员；最下面是「解散群聊」。群主不能退群、不能转让、不能拉人。
/// 群已经用不了的（解散了 / 被关闭 / 我不在了）：只剩「从消息列表里删除」。
/// 页面上的内容靠推送（op: "group"）更新：有人进出、群名公告改了、解散了，不用刷新。
struct GroupInfoView: View {
    let groupId: String

    @EnvironmentObject var state: AppState
    @State private var g: GroupInfo?
    @State private var err = ""
    /// 成员先显示两行（一行 5 个），多了点「全部」展开
    @State private var showAll = false
    /// 群主点了「移出」：成员头像上出现红色的减号，点谁移出谁
    @State private var removing = false
    @State private var confirm: GroupConfirm?
    /// 正在改哪一项：name 群名 | notice 群公告；nil = 没在改
    @State private var editField: String?
    @State private var editText = ""
    @State private var reporting = false
    @State private var busy = false
    @State private var toastMsg: String?
    @State private var pushRoute: Route?
    @State private var removeListener: (() -> Void)?

    private var myId: String { state.user?.id ?? "" }
    private static let fold = 10
    private static let red = Color(red: 0.941, green: 0.267, blue: 0.220)
    private static let pageBg = Color(red: 0.984, green: 0.969, blue: 0.961)

    // body 拆成几段，整块写在一起 Swift 类型检查会超时
    var body: some View {
        dialogs(page)
            .task { await onLoad() }
            .onDisappear {
                removeListener?()
                removeListener = nil
            }
    }

    private var page: some View {
        ScrollView {
            VStack(spacing: 10) {
                if let g {
                    sections(g)
                } else {
                    Text(err.isEmpty ? "加载中…" : err).font(.system(size: 14)).foregroundStyle(HnTheme.ink2)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 20).padding(.vertical, 80)
                }
            }
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 28)
        }
        .background(Self.pageBg.ignoresSafeArea())
        .navigationTitle("群资料")
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Self.pageBg)
        .toast($toastMsg)
        .routePush($pushRoute)
    }

    private func dialogs<V: View>(_ v: V) -> some View {
        v
        .alert(
            confirm?.title ?? "",
            isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }),
            presenting: confirm
        ) { c in
            Button(c.ok, role: .destructive) { c.run() }
            Button(t("common.cancel"), role: .cancel) {}
        } message: { c in
            Text(c.message)
        }
        .sheet(isPresented: Binding(get: { editField != nil }, set: { if !$0 { editField = nil } })) {
            editSheet
        }
        .sheet(isPresented: $reporting) {
            ReportSheet(msgId: "", groupId: groupId) { toastMsg = $0 }
                .compatDetents(height: 460)
        }
    }

    // MARK: 取数据、收推送

    private func load() async {
        do {
            let v: GroupInfo = try await Api.request("/im/group/\(groupId)")
            g = v
            err = ""
        } catch {
            err = (error as? ApiError)?.msg ?? "打不开这个群"
        }
    }

    private func onLoad() async {
        await load()
        WsClient.shared.connect()
        removeListener?()
        removeListener = WsClient.shared.addListener { frame in handleFrame(frame) }
    }

    private func handleFrame(_ frame: [String: Any]) {
        let op = frame["op"] as? String
        // 断线后重新连上：断线那段时间的变化没收到，补拉一次
        if op == "ws_reopen" {
            Task { await load() }
            return
        }
        guard op == "group", let ev = groupEventOf(frame), ev.groupId == groupId, let prev = g else { return }
        // 群名、公告、人数、解散 / 关闭：推送里直接带着，马上改
        var next = prev.merged(ev, myId: myId)
        // 有人退了 / 被移出了：从名单里拿掉；我自己不在了：名单清空
        if ev.event == "leave" || ev.event == "kick", let uid = ev.userId, !uid.isEmpty {
            next.members = uid == myId ? [] : next.memberList.filter { $0.id != uid }
        }
        g = next
        // 有人进群：推送里只有 id 和昵称，头像要重新拿一次名单
        if ev.event == "join" { Task { await load() } }
    }

    /// 做一件要问服务器的事：同一时间只做一件；done 是做成以后的提示
    private func act(done: String? = nil, _ block: @escaping () async throws -> Void) {
        guard !busy else { return }
        busy = true
        Task { @MainActor in
            do {
                try await block()
                if let done { toastMsg = done }
            } catch {
                toastMsg = (error as? ApiError)?.msg ?? "操作失败"
            }
            busy = false
        }
    }

    private func askKick(_ m: GroupMemberView) {
        let name = m.nickname ?? ""
        confirm = GroupConfirm(title: "把 \(name) 移出群聊？", message: "移出以后，TA 不能自己再进这个群。", ok: "移出") {
            act(done: "已把 \(name) 移出") {
                let _: GroupOkResp = try await Api.request("/im/group/\(groupId)/kick", method: "POST", body: ["userId": m.id])
                // 人数、名单以服务器为准：正常情况下推送已经先到了；这里再拿一次，推送万一没到也不会错
                if var cur = g {
                    cur.members = cur.memberList.filter { $0.id != m.id }
                    g = cur
                }
                await load()
            }
        }
    }

    private func leave() {
        act {
            let _: GroupOkResp = try await Api.request("/im/group/\(groupId)/leave", method: "POST")
            NotificationCenter.default.post(name: .hnGroupExit, object: groupId)
        }
    }

    private func dissolve() {
        act(done: "群聊已解散") {
            let _: GroupOkResp = try await Api.request("/im/group/\(groupId)/dissolve", method: "POST")
            await load()
        }
    }

    private func hide() {
        act {
            let _: GroupOkResp = try await Api.request("/im/group/\(groupId)/hide", method: "POST")
            NotificationCenter.default.post(name: .hnGroupExit, object: groupId)
        }
    }

    private func setMuted(_ on: Bool) {
        act {
            // 开关先变，服务器没答应再变回去
            g?.muted = on
            do {
                let r: GroupOkResp = try await Api.request("/im/group/\(groupId)/mute", method: "POST", body: ["muted": on])
                g?.muted = r.muted ?? on
            } catch {
                g?.muted = !on
                throw error
            }
        }
    }

    private func saveEdit() {
        guard let field = editField else { return }
        let value = editText
        act(done: field == "name" ? "群名已修改" : "群公告已更新") {
            let v: GroupInfo = try await Api.request("/im/group/\(groupId)/update", method: "POST", body: [field: value])
            g = v
            editField = nil
        }
    }

    // MARK: 各段

    @ViewBuilder
    private func sections(_ g: GroupInfo) -> some View {
        let owner = g.isOwner
        let gone = g.stateText != "ok"
        headerCard(g, owner: owner, gone: gone)
        if !g.memberList.isEmpty {
            membersCard(g, owner: owner, gone: gone)
        }
        if !g.noticeText.isEmpty || (owner && !gone) {
            noticeCard(g, owner: owner, gone: gone)
        }
        if !gone {
            rowsCard(g, owner: owner)
        }
        bottomButton(owner: owner, gone: gone)
        if !gone && !owner {
            Text("线下见面前不要转账；遇到借钱、投资、推销的，直接举报。")
                .font(.system(size: 12)).foregroundStyle(HnTheme.ink3).multilineTextAlignment(.center).lineSpacing(4)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 8).padding(.top, 2)
        }
    }

    /// 白色圆角卡片
    private func card<V: View>(padded: Bool = true, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, padded ? 15 : 0).padding(.vertical, padded ? 13 : 0)
            .background(RoundedRectangle(cornerRadius: 18).fill(Color.white))
            .shadow(color: HnTheme.ink.opacity(0.05), radius: 8, x: 0, y: 4)
    }

    /// 这个群是什么
    private func headerCard(_ g: GroupInfo, owner: Bool, gone: Bool) -> some View {
        let ownerName = g.memberList.first(where: { $0.role == "owner" })?.nickname ?? ""
        let who: String = owner ? "我是\(ownerLabel(g.kindText))" : ownerLabel(g.kindText) + (ownerName.isEmpty ? "" : " \(ownerName)")
        let sub: String = gone ? groupEndText(g.stateText) : "\(g.count) 人 · \(who)"
        return card {
            HStack(spacing: 12) {
                GroupAvatar(avatar: g.avatar, kind: g.kindText, size: 52)
                VStack(alignment: .leading, spacing: 3) {
                    Text(g.nameText).font(.system(size: 16, weight: .bold)).foregroundStyle(HnTheme.ink).lineLimit(1)
                    Text(sub).font(.system(size: 12.5)).foregroundStyle(HnTheme.ink2).lineLimit(1)
                }
                Spacer(minLength: 0)
                KindTag(kind: g.kindText)
            }
        }
    }

    /// 群成员：一行 5 个；群主最后多一格「移出」
    private func membersCard(_ g: GroupInfo, owner: Bool, gone: Bool) -> some View {
        let all = g.memberList
        let shown = showAll ? all : Array(all.prefix(Self.fold))
        // 群主才有、群里除了自己还有别人时才有的「移出」那一格
        let canRemove = owner && !gone && all.count > 1
        let removingNow = removing && canRemove
        let cols = Array(repeating: GridItem(.flexible(), spacing: 2), count: 5)
        return card {
            HStack {
                Text("群成员").font(.system(size: 14, weight: .heavy)).foregroundStyle(HnTheme.ink)
                Spacer()
                if all.count > Self.fold {
                    Button { showAll.toggle() } label: {
                        Text(showAll ? "收起" : "全部 \(g.count) 人 ›").font(.system(size: 12)).foregroundStyle(HnTheme.ink3)
                    }
                    .buttonStyle(.plain)
                }
            }
            LazyVGrid(columns: cols, spacing: 14) {
                ForEach(shown) { m in
                    memberTile(m, kind: g.kindText, removingNow: removingNow)
                }
                if canRemove {
                    removeTile(removingNow)
                }
            }
            .padding(.top, 12)
            if removingNow {
                Text("点要移出的人。被移出的人不能自己再进这个群。")
                    .font(.system(size: 12)).foregroundStyle(HnTheme.ink3).multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 10)
            }
        }
    }

    /// 成员名单里的一个人：头像 + 昵称；群主头像下面压着「领队 / 发起人」；移出状态下右上角有红色减号
    private func memberTile(_ m: GroupMemberView, kind: String, removingNow: Bool) -> some View {
        let isOwner = m.role == "owner"
        let canKick = removingNow && !isOwner
        return Button {
            if canKick {
                askKick(m)
            } else if !removingNow {
                pushRoute = .userHome(m.id)
            }
        } label: {
            VStack(spacing: 3) {
                AvatarView(url: m.avatar, size: 40)
                    .padding(2)
                    .background(Circle().fill(Color.white))
                    .shadow(color: HnTheme.ink3.opacity(0.35), radius: 3, x: 0, y: 1)
                    .opacity(removingNow && !canKick ? 0.45 : 1)
                    .overlay(alignment: .bottom) {
                        if isOwner {
                            OwnerBadge(kind: kind)
                                .overlay(Capsule().stroke(Color.white, lineWidth: 1.5))
                                .offset(y: 8)
                        }
                    }
                    .overlay(alignment: .topTrailing) {
                        if canKick {
                            Circle().fill(Self.red).frame(width: 18, height: 18)
                                .overlay(Rectangle().fill(Color.white).frame(width: 8, height: 2))
                                .overlay(Circle().stroke(Color.white, lineWidth: 1.5))
                                .offset(x: 5, y: -5)
                        }
                    }
                    .padding(.bottom, 8)
                Text(m.id == myId ? "我" : (m.nickname ?? ""))
                    .font(.system(size: 11)).foregroundStyle(HnTheme.ink2).lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// 群主名单最后的那一格：点了进入「移出」状态，再点一下是「完成」
    private func removeTile(_ removingNow: Bool) -> some View {
        Button {
            removing = !removingNow
            showAll = true
        } label: {
            VStack(spacing: 3) {
                Circle().fill(Color.white).frame(width: 44, height: 44)
                    .overlay(Circle().strokeBorder(Color(red: 0.969, green: 0.659, blue: 0.635), style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])))
                    .overlay {
                        if removingNow {
                            Image(systemName: "checkmark").font(.system(size: 15, weight: .bold)).foregroundStyle(Self.red)
                        } else {
                            Rectangle().fill(Self.red).frame(width: 14, height: 2)
                        }
                    }
                    .padding(.bottom, 8)
                Text(removingNow ? "完成" : "移出").font(.system(size: 11)).foregroundStyle(Self.red).lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// 群公告：只有群主能写
    private func noticeCard(_ g: GroupInfo, owner: Bool, gone: Bool) -> some View {
        let empty = g.noticeText.isEmpty
        return card {
            HStack {
                Text("群公告").font(.system(size: 14, weight: .heavy)).foregroundStyle(HnTheme.ink)
                Spacer()
                if owner && !gone {
                    Button {
                        editText = g.noticeText
                        editField = "notice"
                    } label: {
                        Text("编辑").font(.system(size: 12.5, weight: .bold)).foregroundStyle(HnTheme.rose)
                    }
                    .buttonStyle(.plain)
                }
            }
            Text(empty ? "还没有写群公告" : g.noticeText)
                .font(.system(size: 13)).lineSpacing(5)
                .foregroundStyle(empty ? HnTheme.ink3 : Color(red: 0.294, green: 0.239, blue: 0.263))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 5)
        }
    }

    /// 群名（群主才有）、消息免打扰、举报这个群（成员才有）
    private func rowsCard(_ g: GroupInfo, owner: Bool) -> some View {
        card(padded: false) {
            if owner {
                Button {
                    editText = g.nameText
                    editField = "name"
                } label: {
                    HStack(spacing: 10) {
                        Text("群名").font(.system(size: 14.5)).foregroundStyle(HnTheme.ink)
                        Spacer(minLength: 0)
                        Text(g.nameText).font(.system(size: 13)).foregroundStyle(HnTheme.ink3).lineLimit(1)
                        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(HnTheme.ink3)
                    }
                    .padding(.horizontal, 15).frame(minHeight: 50)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Rectangle().fill(HnTheme.line).frame(height: 1)
            }
            Toggle(isOn: Binding(get: { g.muted == true }, set: { setMuted($0) })) {
                Text("消息免打扰").font(.system(size: 14.5)).foregroundStyle(HnTheme.ink)
            }
            .tint(HnTheme.rose)
            .padding(.horizontal, 15).frame(minHeight: 50)
            if !owner {
                Rectangle().fill(HnTheme.line).frame(height: 1)
                Button { reporting = true } label: {
                    HStack(spacing: 10) {
                        Text("举报这个群").font(.system(size: 14.5)).foregroundStyle(HnTheme.ink)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(HnTheme.ink3)
                    }
                    .padding(.horizontal, 15).frame(minHeight: 50)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// 最下面那个红字按钮：成员是「退出群聊」，群主是「解散群聊」；群已经用不了的是「从消息列表里删除」
    private func bottomButton(owner: Bool, gone: Bool) -> some View {
        Button {
            if gone {
                confirm = GroupConfirm(title: "从消息列表里删除？", message: "只是从你自己的消息列表里删掉，删了以后这个群的聊天记录就看不到了。", ok: "删除") { hide() }
            } else if owner {
                confirm = GroupConfirm(title: "解散群聊？", message: "解散以后所有人都不能再发消息，之前的聊天记录还能看。解散了不能恢复。", ok: "解散") { dissolve() }
            } else {
                confirm = GroupConfirm(title: "退出群聊？", message: "退出以后不会再收到这个群的消息。之后还想进，回到线路 / 活动页重新点「约单 / 参与」。", ok: "退出") { leave() }
            }
        } label: {
            Text(gone ? "从消息列表里删除" : (owner ? "解散群聊" : "退出群聊"))
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(Self.red)
                .frame(maxWidth: .infinity).frame(height: 48)
                .background(RoundedRectangle(cornerRadius: 18).fill(Color.white))
                .shadow(color: HnTheme.ink.opacity(0.05), radius: 8, x: 0, y: 4)
        }
        .buttonStyle(.plain)
        .padding(.top, 2)
    }

    /// 改群名 / 写群公告的弹层
    private var editSheet: some View {
        let isName = editField == "name"
        let canSave = !busy && !(isName && editText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        return VStack(alignment: .leading, spacing: 14) {
            HStack {
                Button(t("common.cancel")) { editField = nil }
                    .font(.system(size: 15)).foregroundStyle(HnTheme.ink2)
                Spacer()
                Text(isName ? "修改群名" : "群公告").font(.system(size: 16, weight: .bold)).foregroundStyle(HnTheme.ink)
                Spacer()
                Button("保存") { saveEdit() }
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(canSave ? HnTheme.rose : HnTheme.ink3)
                    .disabled(!canSave)
            }
            if isName {
                TextField("群名（最多 30 个字）", text: $editText)
                    .font(.system(size: 15)).foregroundStyle(HnTheme.ink)
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Color(red: 0.980, green: 0.965, blue: 0.965)))
            } else {
                Text("集合时间地点、要带什么、注意事项…（最多 500 个字）").font(.system(size: 12.5)).foregroundStyle(HnTheme.ink3)
                TextEditor(text: $editText)
                    .font(.system(size: 15)).foregroundStyle(HnTheme.ink)
                    .frame(minHeight: 130, maxHeight: 240)
                    .padding(8)
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(HnTheme.line, lineWidth: 1))
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .background(Color.white.ignoresSafeArea())
        // 字数上限：群名 30、公告 500（和后端一致），超了直接截掉
        .onChange(of: editText) { v in
            let limit = isName ? 30 : 500
            if v.count > limit { editText = String(v.prefix(limit)) }
        }
    }
}
