import SwiftUI

/// GET /ai-wallet 里用到的那一项（余额，元）
struct AiWalletBrief: Decodable {
    var balance: String?
}

/// GET /kyc/status 里用到的两项：后台要不要求先做实人认证、我做过没有
struct KycStatusBrief: Decodable {
    var required: Bool?
    var realname: Bool?
}

/// GET /devices 里用到的那一项：能登录这个账号的设备（只数个数）
struct DeviceListBrief: Decodable {
    struct Item: Decodable { var id: String? }
    var devices: [Item]?
}

struct DeepMsg: Codable, Identifiable, Hashable {
    var id: String = ""
    /// ai | user
    var role: String? = "ai"
    var text: String? = ""
    /// AI 这句话附带的现成回答
    var quick: [String]? = []
    var topic: Int? = 0
}

struct DeepWallet: Codable, Hashable {
    var balance: String? = "0.00"
    /// platform 平台余额 | own 自己的 Key
    var payMode: String? = "platform"
    var hasKey: Bool? = false
    var feePercent: Int? = 10
}

struct DeepSpent: Codable, Hashable {
    var cost: String? = "0.0000"
    var fee: String? = "0.0000"
    var total: String? = "0.0000"
    var ownKey: Bool? = false
    var calls: Int? = 0
}

/// GET /hn/deep 以及每次操作后返回的状态
struct DeepState: Codable {
    /// 必须先做完点选问答才能深聊
    var profileDone: Bool? = false
    var topics: [String]? = []
    /// 开始前告诉用户大概花多少（元）
    var estimate: String? = ""
    var wallet: DeepWallet? = nil
    /// none 没聊过 | chatting 聊天中 | draft 画像等确认 | done 已确认
    var status: String? = "none"
    /// 聊到第几个话题；等于话题总数 = 都聊过了，在自由补充
    var topic: Int? = 0
    var messages: [DeepMsg]? = []
    /// 最后一句是我说的、AI 还没回（上次没回成）
    var pending: Bool? = false
    var canFinish: Bool? = false
    var spent: DeepSpent? = nil
    /// 这一轮 AI 说聊完了：接着整理画像
    var done: Bool? = false
    /// 自己的 Key 用不了，按设置自动改用了平台余额
    var fellBack: Bool? = false
}

/**
 * AI 深聊（原生）：真的大模型在问、在接话。六个话题聊完整理成画像，用户确认后生效。
 * 可选功能，按用量花模型费（平台余额或自己的 Key）。充值、填 Key、明细、相亲画像是网页（HnWebPage）。
 * 和安卓 DeepChatScreen.kt、网页端 web/src/pages/DeepChat.tsx 是同一套流程和接口；样稿 design/01-ai-interview.html
 * 注意：这个文件是照着安卓写的，iOS 没法在 Windows 上编译，没有编译验证过。
 */
struct DeepChatView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var st: DeepState?
    @State private var card: HnCardBrief?
    @State private var failed = false
    @State private var input = ""
    /// 空 = 没在忙；reply 等 AI 回话；portrait 正在整理画像；other 别的请求
    @State private var busy = ""
    /// 我刚发出去、服务端还没返回的那句话（先显示出来）
    @State private var sending = ""
    @State private var notice = ""
    @State private var askRestart = false
    @State private var push: Route?
    @State private var toastMsg: String?
    @FocusState private var inputFocused: Bool

    /// 调模型失败时的提示卡：标题 + 说明（按服务端返回的 reason 取）
    private static let notices: [String: (title: String, sub: String)] = [
        "no_balance": ("余额不够了，先聊到这里", "你说的都存好了，充值后接着聊。不影响你被推荐和找人聊天。"),
        "key_invalid": ("你的 Key 用不了", "可能已经失效了，或者复制得不完整。"),
        "key_no_balance": ("你的 Key 没有额度了", "需要去 DeepSeek 后台充值，或者换一种付费方式。"),
        "need_key": ("还没有填写你自己的 Key", "填好以后接着聊，或者改用平台余额。"),
        "ai_down": ("AI 暂时没回上话", "不是你的问题，稍等一下再试。这次没有扣费。"),
    ]

    private var status: String { st?.status ?? "none" }
    private var messages: [DeepMsg] { st?.messages ?? [] }
    private var topics: [String] { st?.topics ?? [] }
    private var showLink: Bool { status == "draft" || status == "done" }
    /// 提示卡：上次调用失败的原因；重新进来后原因丢了、只知道 AI 还没回，就给一个「继续」
    private var noticeKey: String {
        if !notice.isEmpty { return notice }
        return status == "chatting" && st?.pending == true && busy.isEmpty ? "ai_down" : ""
    }
    /// 这几样一变就滚到底
    private var scrollKey: String { "\(messages.count)|\(sending)|\(busy)|\(noticeKey)|\(card != nil)" }

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                topBar
                if st != nil, status != "none" { steps }
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            transcript
                            Color.clear.frame(height: 1).id("bottom")
                        }
                        .padding(.horizontal, 16).padding(.top, 8)
                    }
                    .onTapGesture { inputFocused = false }
                    .onChange(of: scrollKey) { _ in
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                            withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                        }
                    }
                }
                bottomArea
            }
            if let s = st, status == "none" { introSheet(s) }
        }
        .background(HnTheme.pageBg.ignoresSafeArea())
        .navigationBarHidden(true)
        .toast($toastMsg)
        .routePush($push)
        .alert("重新聊？", isPresented: $askRestart) {
            Button("重新聊", role: .destructive) { post("/hn/deep/restart") }
            Button("取消", role: .cancel) {}
        } message: {
            Text("会从头开始，之前聊的内容不再用来整理画像。已经确认过的画像不受影响。")
        }
        // 每次出现都重新取一次状态：第一次进来，或者从充值 / 填 Key 的网页回来
        .onAppear { Task { await load() } }
    }

    // MARK: - 顶栏和话题进度

    private var topBar: some View {
        HStack(spacing: 8) {
            Button { dismiss() } label: { HnCircleIcon(systemName: "chevron.left") }.buttonStyle(.plain)
            Spacer()
            Text("AI 红娘").font(.system(size: 16, weight: .bold)).foregroundStyle(HnTheme.ink)
            // 明确标出对面是人工智能，不是真人
            Text("人工智能").font(.system(size: 10, weight: .semibold)).foregroundStyle(HnTheme.rose)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 8).fill(HnTheme.soft))
            Spacer()
            if st != nil, status != "none" {
                Menu {
                    Button("先聊到这（已自动保存）") { dismiss() }
                    if status == "chatting" {
                        Button("聊够了，直接出画像") {
                            if st?.canFinish == true { finish() } else { toastMsg = "再多聊两句，我才好整理" }
                        }
                    }
                    Button("费用明细") { push = .web("/ai-fee/ledger") }
                    Button("重新聊", role: .destructive) { askRestart = true }
                } label: {
                    HnCircleIcon(systemName: "ellipsis")
                }
            } else {
                Color.clear.frame(width: 34, height: 34)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 52)
    }

    private var steps: some View {
        let cur = st?.topic ?? 0
        return HStack(spacing: 5) {
            ForEach(Array(topics.enumerated()), id: \.offset) { i, name in
                let ok = i < cur || status != "chatting"
                let on = !ok && i == cur
                Text(ok ? "✓\(name)" : name)
                    .font(.system(size: 11, weight: on ? .bold : .regular))
                    .foregroundStyle(on ? Color.white : (ok ? HnTheme.rose : HnTheme.ink3))
                    .lineLimit(1).minimumScaleFactor(0.7)
                    .frame(maxWidth: .infinity)
                    .frame(height: 26)
                    .background(Capsule().fill(on ? AnyShapeStyle(HnTheme.grad) : AnyShapeStyle(ok ? HnTheme.soft : Color.white.opacity(0.7))))
            }
        }
        .padding(.horizontal, 14).padding(.top, 4).padding(.bottom, 10)
    }

    // MARK: - 聊天内容

    @ViewBuilder
    private var transcript: some View {
        if let s = st {
            if status == "none" { bubble("你好，我是 AI 红娘，是人工智能，不是真人。", mine: false, gen: false) }
            ForEach(messages) { m in
                bubble(m.text ?? "", mine: m.role != "ai")
            }
            if !sending.isEmpty { bubble(sending, mine: true) }
            if busy == "reply" { bubble("正在输入…", mine: false, gen: false) }
            if busy == "portrait" { bubble("正在整理你的相亲画像，稍等几秒…", mine: false, gen: false) }
            if showLink, let card {
                Button { push = .web("/card/me") } label: { PortraitLinkCard(card: card) }
                    .buttonStyle(.plain)
                    .padding(.leading, 47).padding(.bottom, 14)
            }
            if let n = Self.notices[noticeKey] { noticeCard(n.title, n.sub, pending: s.pending == true) }
        } else {
            Button {
                if failed { Task { await load() } }
            } label: {
                Text(failed ? "没加载出来，点一下重试" : "加载中…")
                    .font(.system(size: 14)).foregroundStyle(HnTheme.ink2)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 80)
            }
            .buttonStyle(.plain)
        }
    }

    /// 对话气泡：AI 红娘在左（白底），我在右（渐变底）。gen = 下面标「AI 生成」
    private func bubble(_ text: String, mine: Bool, gen: Bool = true) -> some View {
        HStack(alignment: .top, spacing: 9) {
            if mine {
                Spacer(minLength: 48)
                Text(text)
                    .font(.system(size: 15)).foregroundStyle(.white).lineSpacing(5)
                    .padding(.horizontal, 15).padding(.vertical, 11)
                    .background(CompatUnevenRounded(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 20, topTrailingRadius: 6).fill(HnTheme.grad))
                    .shadow(color: HnTheme.rose.opacity(0.25), radius: 8, x: 0, y: 5)
                AvatarView(url: state.user?.avatar, size: 38)
                    .overlay(Circle().stroke(Color.white, lineWidth: 2))
            } else {
                HnOrb(size: 38)
                VStack(alignment: .leading, spacing: 5) {
                    Text(text)
                        .font(.system(size: 15)).foregroundStyle(HnTheme.ink).lineSpacing(5)
                        .padding(.horizontal, 15).padding(.vertical, 11)
                        .background(CompatUnevenRounded(topLeadingRadius: 6, bottomLeadingRadius: 20, bottomTrailingRadius: 20, topTrailingRadius: 20).fill(Color.white))
                        .shadow(color: HnTheme.ink.opacity(0.06), radius: 8, x: 0, y: 4)
                    if gen {
                        Text("✦ AI 生成").font(.system(size: 10)).foregroundStyle(HnTheme.ink3).padding(.leading, 6)
                    }
                }
                Spacer(minLength: 48)
            }
        }
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    /// 余额不够 / Key 用不了 / AI 没回上话 时的提示卡
    private func noticeCard(_ title: String, _ sub: String, pending: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(.system(size: 15.5, weight: .heavy)).foregroundStyle(HnTheme.ink)
            Text(sub).font(.system(size: 12.5)).foregroundStyle(HnTheme.ink2).lineSpacing(3).padding(.top, 3)
            HStack(spacing: 10) {
                switch noticeKey {
                case "no_balance":
                    Button { push = .web("/ai-fee/topup") } label: { HnPillLabel(title: "去充值") }.buttonStyle(.plain)
                    Button { push = .web("/ai-fee/key") } label: { HnPillLabel(title: "改用我自己的 Key", ghost: true) }.buttonStyle(.plain)
                case "key_invalid", "key_no_balance":
                    Button { push = .web("/ai-fee/key") } label: { HnPillLabel(title: "换一个 Key") }.buttonStyle(.plain)
                    Button { pickMode("platform") { notice = "ai_down" } } label: { HnPillLabel(title: "改用平台余额", ghost: true) }.buttonStyle(.plain)
                case "need_key":
                    Button { push = .web("/ai-fee/key") } label: { HnPillLabel(title: "去填写 Key") }.buttonStyle(.plain)
                    Button { pickMode("platform") { notice = "ai_down" } } label: { HnPillLabel(title: "改用平台余额", ghost: true) }.buttonStyle(.plain)
                default:
                    Button { if pending { send() } else { notice = "" } } label: { HnPillLabel(title: pending ? "继续" : "知道了") }.buttonStyle(.plain)
                }
                Spacer(minLength: 0)
            }
            .padding(.top, 14)
            if noticeKey != "ai_down", pending {
                Button { send() } label: { HnPillLabel(title: "解决了，继续", ghost: true) }.buttonStyle(.plain).padding(.top, 8)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 22).fill(Color.white))
        .shadow(color: HnTheme.rose.opacity(0.1), radius: 10, x: 0, y: 6)
        .padding(.bottom, 14)
    }

    // MARK: - 底部：聊天中是现成回答 + 输入框；画像等确认时是两个按钮；确认后是「再聊聊」

    @ViewBuilder
    private var bottomArea: some View {
        if let s = st {
            let blocked = !noticeKey.isEmpty
            switch status {
            case "chatting":
                VStack(spacing: 10) {
                    if !blocked, busy.isEmpty { quickReplies(s) }
                    HStack(spacing: 8) {
                        TextField(blocked ? "暂时不能发" : "也可以自己打字…", text: $input)
                            .font(.system(size: 15)).foregroundStyle(HnTheme.ink)
                            .focused($inputFocused)
                            .submitLabel(.send)
                            .onSubmit { send(text: input) }
                            .onChange(of: input) { v in if v.count > 500 { input = String(v.prefix(500)) } }
                            .disabled(blocked || !busy.isEmpty)
                            .padding(.horizontal, 18)
                            .frame(height: 46)
                            .background(Capsule().fill(Color.white.opacity(blocked ? 0.6 : 1)))
                            .shadow(color: HnTheme.ink.opacity(0.07), radius: 8, x: 0, y: 4)
                        let canSend = !blocked && busy.isEmpty && !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        Button { send(text: input) } label: {
                            Image(systemName: "arrow.up").font(.system(size: 18, weight: .bold)).foregroundStyle(.white)
                                .frame(width: 46, height: 46)
                                .background(Circle().fill(HnTheme.grad))
                                .opacity(canSend ? 1 : 0.45)
                        }
                        .buttonStyle(.plain)
                        .disabled(!canSend)
                    }
                    costLine(s, total: false)
                }
                .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 12)
            case "draft":
                VStack(spacing: 10) {
                    HStack(spacing: 10) {
                        Button { post("/hn/deep/resume") } label: { HnButtonLabel(title: "再聊聊", ghost: true, enabled: busy.isEmpty) }
                            .buttonStyle(.plain).disabled(!busy.isEmpty)
                        Button { post("/hn/deep/confirm") } label: { HnButtonLabel(title: "确认，就这样", enabled: busy.isEmpty) }
                            .buttonStyle(.plain).disabled(!busy.isEmpty)
                    }
                    costLine(s, total: true)
                }
                .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 12)
            case "done":
                Button { post("/hn/deep/resume") } label: { HnButtonLabel(title: "✦ 再和 AI 聊聊", ghost: true, enabled: busy.isEmpty) }
                    .buttonStyle(.plain).disabled(!busy.isEmpty)
                    .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 14)
            default:
                EmptyView()
            }
        }
    }

    /// AI 给的现成回答（点一下就发）+ 先不说 / 换个话题
    private func quickReplies(_ s: DeepState) -> some View {
        let quick = messages.last(where: { $0.role == "ai" })?.quick ?? []
        let extra = (s.topic ?? 0) >= topics.count
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 8)], alignment: .leading, spacing: 8) {
            ForEach(quick, id: \.self) { q in
                Button { send(text: q) } label: { chip(q, strong: true) }.buttonStyle(.plain)
            }
            Button { send(action: "skip") } label: { chip("先不说", strong: false) }.buttonStyle(.plain)
            if !extra {
                Button { send(action: "next") } label: { chip("换个话题", strong: false) }.buttonStyle(.plain)
            }
            if extra, s.canFinish == true {
                Button { finish() } label: { chip("聊够了，出画像", strong: false) }.buttonStyle(.plain)
            }
        }
    }

    /// 现成回答的小块：strong = AI 给的（玫红字），其余是灰字
    private func chip(_ text: String, strong: Bool) -> some View {
        Text(text)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(strong ? HnTheme.rose : HnTheme.ink2)
            .lineLimit(1).minimumScaleFactor(0.7)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 10).padding(.vertical, 9)
            .background(Capsule().fill(Color.white))
            .overlay(Capsule().stroke(strong ? HnTheme.rose.opacity(0.28) : HnTheme.line, lineWidth: 1))
    }

    /// 最下面的小字：这次花了多少、余额还剩多少，点一下看明细
    @ViewBuilder
    private func costLine(_ s: DeepState, total: Bool) -> some View {
        if let sp = s.spent {
            let ownNow = s.wallet?.payMode == "own" && s.wallet?.hasKey == true
            let text: String = {
                if sp.ownKey == true || (ownNow && (sp.calls ?? 0) == 0) { return "用的是你自己的 Key，平台没有扣费" }
                if total { return "本次共花 ¥\(sp.total ?? "0")（模型费 ¥\(sp.cost ?? "0") + 手续费 ¥\(sp.fee ?? "0")）" }
                if ownNow { return "本次已花 ¥\(sp.total ?? "0") · 现在用你自己的 Key" }
                return "本次已花 ¥\(sp.total ?? "0") · 余额 ¥\(s.wallet?.balance ?? "0.00")"
            }()
            Button { push = .web("/ai-fee/ledger") } label: {
                Text("\(text)  ›").font(.system(size: 11)).foregroundStyle(HnTheme.ink2)
                    .padding(.horizontal, 12).padding(.vertical, 5)
                    .background(Capsule().fill(Color.white.opacity(0.75)))
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - 第一次进来：说明 + 选谁付模型费

    private func introSheet(_ s: DeepState) -> some View {
        let own = s.wallet?.payMode == "own" && s.wallet?.hasKey == true
        let empty = (Double(s.wallet?.balance ?? "0") ?? 0) <= 0
        let canStart = own || !empty
        return ZStack(alignment: .bottom) {
            Color(red: 0.169, green: 0.078, blue: 0.110).opacity(0.42).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                VStack(spacing: 0) {
                    HnOrb(size: 60)
                    Text("和 AI 红娘深聊").font(.system(size: 21, weight: .heavy)).foregroundStyle(HnTheme.ink).padding(.top, 14)
                    Text("我是人工智能，不是真人").font(.system(size: 12, weight: .semibold)).foregroundStyle(HnTheme.rose)
                        .padding(.horizontal, 12).padding(.vertical, 4)
                        .background(Capsule().fill(HnTheme.soft))
                        .padding(.top, 8)
                }
                .frame(maxWidth: .infinity)
                introLine("大约 10 分钟，聊性格、生活习惯、对家庭的想法和想找的人").padding(.top, 16)
                introLine("不想说的就说「先不说」，随时能停，下次接着聊").padding(.top, 12)
                introLine("聊完整理成画像，你确认了才生效。你说的不好的地方也会如实记下来，对方能看到").padding(.top, 12)

                if s.profileDone == true {
                    HStack {
                        Text("费用怎么付").font(.system(size: 14, weight: .bold)).foregroundStyle(HnTheme.ink)
                        Spacer()
                        Text("这次预计 ¥\(s.estimate ?? "") 以内").font(.system(size: 12)).foregroundStyle(HnTheme.ink2)
                    }
                    .padding(.top, 18)
                    payOption(
                        "平台余额  ¥\(s.wallet?.balance ?? "0.00")", "DeepSeek 实际费用 + \(s.wallet?.feePercent ?? 10)% 手续费",
                        selected: !own, trailing: empty ? "去充值" : nil, onTrailing: { push = .web("/ai-fee/topup") }
                    ) { pickMode("platform") {} }
                    payOption(
                        "我自己的 DeepSeek Key", "用你自己的额度，平台不扣余额",
                        selected: own, trailing: s.wallet?.hasKey == true ? nil : "去填写", onTrailing: { push = .web("/ai-fee/key") }
                    ) { if s.wallet?.hasKey == true { pickMode("own") {} } else { push = .web("/ai-fee/key") } }
                    Button { post("/hn/deep/start") } label: { HnButtonLabel(title: "开始聊", enabled: canStart && busy.isEmpty) }
                        .buttonStyle(.plain).disabled(!canStart || !busy.isEmpty)
                        .padding(.top, 16)
                    Text(canStart ? "不聊也不影响你被推荐和找人聊天" : "余额是 0，也没有填 Key：先充值，或者填自己的 Key")
                        .font(.system(size: 11)).foregroundStyle(HnTheme.ink3)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 10)
                } else {
                    Text("深聊之前，先把基本情况的问答做完（免费，大概 3 分钟）。")
                        .font(.system(size: 13)).foregroundStyle(HnTheme.ink2).lineSpacing(4)
                        .padding(.top, 18)
                    Button { push = .interview } label: { HnButtonLabel(title: "先去填基本情况") }
                        .buttonStyle(.plain)
                        .padding(.top, 14)
                }
                Button { dismiss() } label: {
                    Text("以后再说").font(.system(size: 14.5)).foregroundStyle(HnTheme.ink2)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Capsule().fill(Color(red: 0.961, green: 0.941, blue: 0.945)))
                }
                .buttonStyle(.plain)
                .padding(.top, 10)
            }
            .padding(EdgeInsets(top: 24, leading: 20, bottom: 18, trailing: 20))
            .background(
                CompatUnevenRounded(topLeadingRadius: 30, topTrailingRadius: 30).fill(Color.white).ignoresSafeArea(edges: .bottom)
            )
        }
    }

    private func introLine(_ text: String) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Text("✦").font(.system(size: 15)).foregroundStyle(HnTheme.rose)
                .frame(width: 36, height: 36)
                .background(RoundedRectangle(cornerRadius: 12).fill(HnTheme.soft))
            Text(text).font(.system(size: 14)).foregroundStyle(HnTheme.ink).lineSpacing(3)
            Spacer(minLength: 0)
        }
    }

    /// 付费方式的一张选择卡：选中的描边变红；trailing 是右边的小字按钮（去充值 / 去填写）
    private func payOption(_ title: String, _ sub: String, selected: Bool, trailing: String?, onTrailing: @escaping () -> Void, onTap: @escaping () -> Void) -> some View {
        Button(action: onTap) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 14.5, weight: .bold)).foregroundStyle(HnTheme.ink)
                    Text(sub).font(.system(size: 11)).foregroundStyle(HnTheme.ink3)
                }
                Spacer()
                if let trailing {
                    Button(action: onTrailing) {
                        Text(trailing).font(.system(size: 13, weight: .semibold)).foregroundStyle(HnTheme.rose)
                    }
                    .buttonStyle(.plain)
                } else if selected {
                    Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 20, height: 20)
                        .background(Circle().fill(HnTheme.grad))
                } else {
                    Circle().stroke(HnTheme.ink3, lineWidth: 1.5).frame(width: 20, height: 20)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 18).fill(selected ? Color(red: 1.0, green: 0.961, blue: 0.965) : Color.white))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(selected ? HnTheme.rose : HnTheme.line, lineWidth: 1.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 8)
    }

    // MARK: - 请求

    private func load() async {
        failed = false
        do {
            let s: DeepState = try await Api.request("/hn/deep")
            st = s
            await loadCard()
        } catch {
            failed = st == nil
        }
    }

    /// 画像整理好以后，聊天里那张卡片要用的几项
    private func loadCard() async {
        guard showLink else { return }
        if let c: HnCardBrief = try? await Api.request("/hn/card/me") { card = c }
    }

    /// 「我的」页的画像卡片读的是全局 user，深聊的状态变了同步一下
    private func refreshMe() async {
        if let u: UserProfile = try? await Api.request("/user/me") { state.user = u }
    }

    private func fail(_ error: Error) {
        let reason = (error as? ApiError)?.reason ?? ""
        if Self.notices[reason] != nil { notice = reason } else { toastMsg = error.localizedDescription }
    }

    /// 聊完后把聊天记录整理成画像
    private func finish() {
        guard busy.isEmpty else { return }
        busy = "portrait"
        Task {
            do {
                let s: DeepState = try await Api.request("/hn/deep/finish", method: "POST")
                st = s
                notice = ""
                await loadCard()
                await refreshMe()
            } catch {
                fail(error)
            }
            busy = ""
        }
    }

    /// 说一句 / 点现成回答 / 先不说（skip）/ 换个话题（next）；什么都不带 = 让 AI 重新回上一句
    private func send(text: String = "", action: String = "") {
        guard let s = st, busy.isEmpty else { return }
        let shown = action == "skip" ? "先不说" : action == "next" ? "换个话题" : text.trimmingCharacters(in: .whitespacesAndNewlines)
        if shown.isEmpty && s.pending != true { return }
        input = ""
        notice = ""
        sending = shown
        busy = "reply"
        inputFocused = false
        Task {
            var done = false
            do {
                var body: [String: Any] = [:]
                if !action.isEmpty { body["action"] = action } else if !shown.isEmpty { body["text"] = shown }
                let next: DeepState = try await Api.request("/hn/deep/message", method: "POST", body: body)
                st = next
                done = next.done == true
                if next.fellBack == true { toastMsg = "你的 Key 用不了，已改用平台余额" }
            } catch {
                fail(error)
                // 我说的话服务端已经存下了，重新取一次状态把它显示出来
                if let again: DeepState = try? await Api.request("/hn/deep") { st = again }
            }
            sending = ""
            busy = ""
            // AI 说聊完了：接着整理画像
            if done { finish() }
        }
    }

    private func post(_ path: String) {
        guard busy.isEmpty else { return }
        busy = "other"
        Task {
            do {
                let s: DeepState = try await Api.request(path, method: "POST")
                st = s
                notice = ""
                await loadCard()
                await refreshMe()
            } catch {
                fail(error)
            }
            busy = ""
        }
    }

    private func pickMode(_ mode: String, then: @escaping () -> Void) {
        Task {
            do {
                let _: AiWalletBrief = try await Api.request("/ai-wallet/mode", method: "PUT", body: ["payMode": mode])
                await load()
                then()
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }
}
