import SwiftUI

/// 资料收集的一道题（GET /hn/interview）；题目、选项都是服务端按性别给的固定模板
struct HnQuestion: Codable, Identifiable, Hashable {
    var key: String = ""
    var label: String? = ""
    var ask: String? = ""
    /// single | multi | text | number | city
    var type: String? = "single"
    var options: [String]? = []
    var max: Int? = 0
    var min: Int? = 0
    var hint: String? = ""
    /// number 题的滚轮：每一格的文字，第 i 格的值是 min + i
    var wheel: [String]? = []
    /// number 题滚轮一开始停在哪个值
    var def: Int? = 0
    /// single 题：选项里没有可以自己填
    var custom: Bool? = false
    /// text 题：示例句，点一下填进输入框
    var samples: [String]? = []
    var `optional`: Bool? = false
    /// true = 「想找的人」那一组
    var pref: Bool? = false
    var answered: Bool? = false
    var value: [String]? = []
    var display: String? = ""

    var id: String { key }
}

struct HnProfileBrief: Codable, Hashable {
    var summary: String? = ""
    var tags: [String]? = []
}

struct HnState: Codable {
    var intro: [String]? = []
    var outro: String? = ""
    var confirmedText: String? = ""
    var skipText: String? = ""
    var questions: [HnQuestion]? = []
    /// 全部问题都答过了
    var complete: Bool? = false
    /// 已确认 = 完成资料收集
    var confirmed: Bool? = false
    var profile: HnProfileBrief? = nil
}

struct MatchRow: Codable, Hashable {
    var label: String? = ""
    var value: String? = ""
}

/// 相亲资料卡（AI 红娘收集的画像，给别人看的那部分，不含收入）
struct MatchProfile: Codable, Hashable {
    var summary: String? = ""
    var tags: [String]? = []
    var intro: String? = ""
    var about: [MatchRow]? = []
    var prefs: [MatchRow]? = []
}

/// 画像里的小标签（自己的画像卡、别人主页的相亲资料卡共用）；一行放不下自动换行
struct MatchTagsView: View {
    let tags: [String]
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), spacing: 6, alignment: .leading)], alignment: .leading, spacing: 6) {
            ForEach(tags, id: \.self) { tag in
                Text(tag).font(.system(size: 12)).foregroundStyle(Theme.accent).lineLimit(1)
                    .padding(.horizontal, 9).padding(.vertical, 3)
                    .background(Capsule().fill(Theme.accent.opacity(0.1)))
            }
        }
    }
}

/// 别人主页上的「相亲资料」：摘要 + 一句话介绍 + 标签 + 明细（对方完成资料收集后才有）
struct MatchProfileCard: View {
    let p: MatchProfile

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(t("userHome.matchProfile")).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
            Text(p.summary ?? "").font(.system(size: 14)).foregroundStyle(Theme.text).lineSpacing(5).padding(.top, 8)
            if let intro = p.intro, !intro.isEmpty {
                Text("“\(intro)”").font(.system(size: 13)).foregroundStyle(Theme.textSub).lineSpacing(4).padding(.top, 6)
            }
            MatchTagsView(tags: p.tags ?? []).padding(.top, 10)
            rows(p.about ?? [], title: nil)
            rows(p.prefs ?? [], title: t("userHome.lookingFor"))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 18)
    }

    @ViewBuilder
    private func rows(_ list: [MatchRow], title: String?) -> some View {
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                if let title {
                    Text(title).font(.system(size: 12)).foregroundStyle(Theme.textSub).padding(.top, 8).padding(.bottom, 2)
                }
                ForEach(list, id: \.self) { r in
                    HStack(alignment: .top, spacing: 10) {
                        Text(r.label ?? "").font(.system(size: 14)).foregroundStyle(Theme.textSub)
                            .frame(width: 92, alignment: .leading)
                        Text(r.value ?? "").font(.system(size: 14)).foregroundStyle(Theme.text)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .multilineTextAlignment(.trailing)
                    }
                    .padding(.vertical, 9)
                    Rectangle().fill(Theme.line).frame(height: 0.5)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
            .padding(.top, 12)
        }
    }
}

private extension View {
    /// 多行输入框去掉系统自带的白底（iOS 16 起才有这个开关；iOS 15 保持白底）
    @ViewBuilder
    func hnClearEditorBackground() -> some View {
        if #available(iOS 16.0, *) {
            self.scrollContentBackground(.hidden)
        } else {
            self
        }
    }
}

/// 注册完自动弹出的资料收集（fullScreenCover 用，带返回按钮）
struct InterviewSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavStack {
            InterviewView()
                .withRoutes()
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

/**
 * AI 红娘资料收集（「编辑资料」进来就是这里）：聊天样式的一问一答，题目是服务端的固定模板，不调大模型。
 * 答一题存一题，中途退出下次接着问；全部答完出相亲画像，确认后才算完成；之后点画像里任意一行可以改。
 */
struct InterviewView: View {
    /// 从相亲画像网页点某一项过来改（改完直接回画像网页）；空 = 正常进入
    var editKey: String = ""
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    /// 答完以后聊天里放的那张画像卡片（点开是相亲画像网页）
    @State private var link: HnCardBrief?
    @State private var push: Route?
    /// 确认基本画像后邀请深聊，点了「以后再说」就不再显示
    @State private var inviteOff = false
    /// 后台要求先做实人认证、而我还没做：答完题后多一步「去完成实人认证」
    @State private var needKyc = false
    @State private var st: HnState?
    @State private var failed = false
    /// 画像出来以后，正在重新回答的那一题
    @State private var editing: String?
    @State private var input = ""
    @State private var picked: [String] = []
    /// 滚轮停在第几格
    @State private var wheelIdx = 0
    @State private var busy = false
    @State private var showCity = false
    @State private var toastMsg: String?
    @FocusState private var inputFocused: Bool

    private var questions: [HnQuestion] { st?.questions ?? [] }

    private var current: HnQuestion? {
        guard st != nil else { return nil }
        if let editing { return questions.first { $0.key == editing } }
        return questions.first { $0.answered != true }
    }

    private var answeredCount: Int { questions.filter { $0.answered == true }.count }

    /// 这几样一变就滚到底
    private var scrollKey: String {
        "\(answeredCount)|\(editing ?? "")|\(st?.complete == true)|\(st?.confirmed == true)"
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        transcript
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
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
        .fullBg()
        .toast($toastMsg)
        .routePush($push)
        .navigationTitle(t("hn.title"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                HStack(spacing: 8) {
                    // 明确标出对面是人工智能，不是真人
                    Text(t("hn.aiBadge")).font(.system(size: 10)).foregroundStyle(Theme.accent)
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Theme.accent.opacity(0.12)))
                    if st != nil {
                        Text(t("hn.progress", ["n": answeredCount, "total": questions.count]))
                            .font(.system(size: 12)).foregroundStyle(Theme.textSub)
                    }
                }
            }
        }
        .sheet(isPresented: $showCity) {
            CityPickerSheet(current: current?.value?.first ?? state.user?.cityName ?? "") { city in
                showCity = false
                submit([city])
            }
        }
        .task { await load() }
        // 每次回到这一页（包括从认证网页回来）都重新看一次还要不要做实人认证
        .onAppear { Task { await loadKyc() } }
        // 换题时重置回答区；改已经答过的题时带上原来的回答
        .onChange(of: current?.key) { _ in resetInput() }
        .onChange(of: editing) { _ in resetInput() }
    }

    // MARK: - 对话区

    @ViewBuilder
    private var transcript: some View {
        if let st {
            // 还没答完：开场白 + 已经答过的一问一答；答完后只留画像，不重放整段对话
            if st.complete != true {
                ForEach(Array((st.intro ?? []).enumerated()), id: \.offset) { _, s in
                    bubble(s, mine: false)
                }
                ForEach(questions.filter { $0.answered == true }) { q in
                    bubble(q.ask ?? "", mine: false)
                    bubble(q.display ?? "", mine: true)
                }
            } else {
                // 答完以后：聊天里只放一张画像卡片（像一条网页链接），点开是相亲画像网页，头像、昵称、照片、每一项都在那一页；
                // 想改哪一项，在那一页点它，会回到这里重新回答。原来这里那张很长的表格去掉了（用户 2026-11-23 要求）。
                bubble(
                    st.confirmed == true
                        ? "你的资料已经收集完成，可以去找人聊天了。想改哪一项，点开下面的画像，点那一项就行。"
                        : "都问完了。我把你的相亲画像整理成了一页，点开看看对不对，没问题就点「确认」。",
                    mine: false
                )
                if let link {
                    Button { push = .web("/card/me") } label: { PortraitLinkCard(card: link) }
                        .buttonStyle(.plain)
                        .padding(.leading, 46).padding(.top, 4).padding(.bottom, 12)
                }
                if st.confirmed != true, editing == nil {
                    VStack(spacing: 8) {
                        Button { confirm() } label: { HnButtonLabel(title: t("hn.confirm"), enabled: !busy) }
                            .buttonStyle(.plain).disabled(busy)
                        Text("哪里不对，点开上面的画像，点那一项就能改").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    }
                    .frame(maxWidth: 330)
                    .padding(.leading, 46).padding(.bottom, 12)
                }
                // 最后一步：实人认证（后台要求且还没做时才出现；做过才能聊天 / 发动态 / 评论）。认证页是网页，内嵌打开
                if needKyc, editing == nil {
                    bubble("最后一步：做个实人认证，画像就完成了，之后就能和心动的人聊天。身份证 + 刷脸，一次完成，¥1 从 AI 余额扣。", mine: false)
                    Button { push = .web("/kyc?next=/interview") } label: { HnButtonLabel(title: "去完成实人认证", height: 44) }
                        .buttonStyle(.plain)
                        .frame(maxWidth: 330)
                        .padding(.leading, 46).padding(.bottom, 12)
                }
                // 基本画像确认后，没深聊过的邀请一下（可选，花一点模型费）
                if st.confirmed == true, editing == nil, (state.user?.deepStatus ?? "none") == "none", !inviteOff {
                    bubble("想让我更了解你吗？和我深聊 10 分钟，聊聊性格和想法，推荐会更准。这一步用的是真的 AI，会花几分钱的模型费，不聊也不影响你找人聊天。", mine: false)
                    HStack(spacing: 10) {
                        Button { inviteOff = true } label: { HnButtonLabel(title: "以后再说", ghost: true, height: 44) }.buttonStyle(.plain)
                        Button { push = .deep } label: { HnButtonLabel(title: "开始深聊", height: 44) }.buttonStyle(.plain)
                    }
                    .frame(maxWidth: 330)
                    .padding(.leading, 46).padding(.bottom, 12)
                }
            }
            if editing != nil, current != nil {
                bubble(t("hn.editAgain"), mine: false)
            }
            if let q = current {
                bubble(q.ask ?? "", mine: false)
            }
        } else {
            Button {
                if failed { Task { await load() } }
            } label: {
                Text(failed ? t("hn.loadFailed") : t("common.loading"))
                    .font(.system(size: 14)).foregroundStyle(Theme.textSub)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 80)
            }
            .buttonStyle(.plain)
        }
    }

    /// 对话气泡：AI 红娘在左（渐变 AI 头像），我在右（自己头像）
    private func bubble(_ text: String, mine: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            if mine { Spacer(minLength: 50) }
            if !mine { AiIconView(size: 38) }
            Text(text)
                .font(.system(size: 15))
                .foregroundStyle(Theme.text)
                .lineSpacing(4)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(
                    (mine
                        ? CompatUnevenRounded(topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 4)
                        : CompatUnevenRounded(topLeadingRadius: 4, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 16))
                        .fill(mine ? Theme.bubbleMine : Theme.bg3)
                )
            if mine { AvatarView(url: state.user?.avatar, size: 38) }
            if !mine { Spacer(minLength: 50) }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    // MARK: - 底部回答区

    @ViewBuilder
    private var bottomArea: some View {
        if let st, let q = current {
            VStack(alignment: .leading, spacing: 10) {
                answerInput(q)
                HStack(spacing: 14) {
                    if editing != nil {
                        // 从画像网页点过来改的，取消就回画像网页
                        Button(t("common.cancel")) { if !editKey.isEmpty, editing == editKey { dismiss() } else { editing = nil } }
                            .font(.system(size: 14)).foregroundStyle(Theme.textSub)
                    }
                    Spacer()
                    if q.optional == true {
                        Button(st.skipText ?? "") { submit([]) }
                            .font(.system(size: 14)).foregroundStyle(Theme.textSub)
                    }
                    if q.type == "multi" {
                        let can = !picked.isEmpty && !busy
                        Button { submit(picked) } label: {
                            Text(t("hn.multiDone", ["n": picked.count]))
                                .font(.system(size: 14)).foregroundStyle(can ? Color.white : Theme.textDim)
                                .padding(.horizontal, 16).padding(.vertical, 8)
                                .background(Capsule().fill(can ? Theme.accent : Theme.bg3))
                        }
                        .buttonStyle(.plain)
                        .disabled(!can)
                    }
                    if q.type == "text" {
                        Text("\(input.count)/\(textLimit(q))").font(.system(size: 12)).foregroundStyle(Theme.textDim)
                        sendButton
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.bg2)
        }
    }

    /// 每种题一种回答方式：滚轮 / 点选项 / 多选 / 点城市 / 多行输入
    @ViewBuilder
    private func answerInput(_ q: HnQuestion) -> some View {
        let type = q.type ?? "single"
        if type == "number" {
            // 数字题（出生年份、身高）：滚轮拨到哪格算哪格，点「确定」提交
            let labels = wheelLabels(q)
            VStack(spacing: 10) {
                Picker("", selection: $wheelIdx) {
                    ForEach(labels.indices, id: \.self) { i in
                        Text(labels[i]).foregroundColor(Theme.text).tag(i)
                    }
                }
                .pickerStyle(.wheel)
                .frame(height: 170)
                .clipped()
                AccentButton(title: t("common.ok"), enabled: !busy) {
                    submit([String((q.min ?? 0) + Swift.min(wheelIdx, labels.count - 1))])
                }
            }
        } else if type == "single" || type == "multi" {
            let opts = q.options ?? []
            VStack(spacing: 10) {
                // 选项多了就限高、里面自己滚
                if opts.count > 18 {
                    ScrollView { chips(q, opts) }.frame(height: 220)
                } else {
                    chips(q, opts)
                }
                // 单选题带「自己填」：选项里没有合适的就在这里打字
                if type == "single", q.custom == true {
                    HStack(spacing: 8) {
                        TextField("", text: $input, prompt: Text(hintText(q)).foregroundColor(Theme.textDim))
                            .focused($inputFocused)
                            .foregroundStyle(Theme.text)
                            .padding(.horizontal, 14).padding(.vertical, 9)
                            .background(RoundedRectangle(cornerRadius: 20).fill(Theme.bg3))
                            .onChange(of: input) { v in
                                if v.count > textLimit(q) { input = String(v.prefix(textLimit(q))) }
                            }
                        sendButton
                    }
                }
            }
        } else if type == "city" {
            cityChips(q)
        } else {
            // 填空题（自我介绍）：示例句点一下填进去，再自己改
            VStack(alignment: .leading, spacing: 6) {
                // 键盘弹起来以后屏幕不够高，示例句先收起
                if let samples = q.samples, !samples.isEmpty, !inputFocused {
                    Text(t("hn.sampleHint")).font(.system(size: 12)).foregroundStyle(Theme.textSub)
                    ForEach(samples, id: \.self) { s in
                        Button { input = String(s.prefix(textLimit(q))) } label: {
                            Text(s).font(.system(size: 13)).foregroundStyle(Theme.text).lineSpacing(3)
                                .multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 12).padding(.vertical, 9)
                                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg3))
                        }
                        .buttonStyle(.plain)
                    }
                }
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $input)
                        .font(.system(size: 14))
                        .foregroundColor(Theme.text)
                        .focused($inputFocused)
                        .hnClearEditorBackground()
                        .frame(height: 84)
                        .onChange(of: input) { v in
                            if v.count > textLimit(q) { input = String(v.prefix(textLimit(q))) }
                        }
                    if input.isEmpty {
                        Text(hintText(q)).font(.system(size: 14)).foregroundColor(Theme.textDim)
                            .padding(.horizontal, 5).padding(.vertical, 8)
                            .allowsHitTesting(false)
                    }
                }
                .padding(.horizontal, 9).padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg3))
                .clipShape(RoundedRectangle(cornerRadius: 14))
            }
        }
    }

    private func hintText(_ q: HnQuestion) -> String {
        (q.hint ?? "").isEmpty ? t("hn.inputHint") : (q.hint ?? "")
    }

    /// 自己打字的题最多几个字（服务端没给就按：自我介绍 100、其它 20）
    private func textLimit(_ q: HnQuestion) -> Int {
        (q.max ?? 0) > 0 ? (q.max ?? 0) : (q.type == "text" ? 100 : 20)
    }

    private var sendButton: some View {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let can = !text.isEmpty && !busy
        return Button { submit([text]) } label: {
            Text(t("common.send")).font(.system(size: 14)).foregroundStyle(can ? Color.white : Theme.textDim)
                .padding(.horizontal, 16).frame(height: 40)
                .background(Capsule().fill(can ? Theme.accent : Theme.bg3))
        }
        .buttonStyle(.plain)
        .disabled(!can)
    }

    /// 选项小圆角块：选中的是渐变色；accent = 文字用主题色（「其他城市」）
    private func chipLabel(_ text: String, on: Bool, accent: Bool = false) -> some View {
        Text(text).font(.system(size: 14)).foregroundStyle(on ? Color.white : (accent ? Theme.accent : Theme.text))
            .lineLimit(1).minimumScaleFactor(0.75)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 8).padding(.vertical, 9)
            .background(Capsule().fill(on ? AnyShapeStyle(Theme.accentGrad) : AnyShapeStyle(Theme.bg3)))
    }

    private func chips(_ q: HnQuestion, _ opts: [String]) -> some View {
        let multi = q.type == "multi"
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 8)], spacing: 8) {
            ForEach(opts, id: \.self) { o in
                // 单选题改答案时，原来选的那个亮着
                let on = multi ? picked.contains(o) : q.value?.first == o
                Button {
                    if !multi {
                        submit([o])
                    } else if on {
                        picked.removeAll { $0 == o }
                    } else if (q.max ?? 0) > 0, picked.count >= (q.max ?? 0) {
                        toastMsg = q.ask
                    } else {
                        picked.append(o)
                    }
                } label: {
                    chipLabel(o, on: on)
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// 城市题：自己所在的城市 + 热门城市直接点，其余的点「其他城市」打开完整列表
    private func cityChips(_ q: HnQuestion) -> some View {
        let cur = q.value?.first ?? ""
        let cities = cityShortlist(cur)
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 8)], spacing: 8) {
            ForEach(cities, id: \.self) { c in
                Button { submit([c]) } label: { chipLabel(c, on: c == cur) }
                    .buttonStyle(.plain)
            }
            Button { if !busy { showCity = true } } label: { chipLabel(t("hn.moreCity") + " ›", on: false, accent: true) }
                .buttonStyle(.plain)
        }
    }

    /// 原来选的城市、自己所在的城市排前面，后面是热门城市（去重）
    private func cityShortlist(_ cur: String) -> [String] {
        var out: [String] = []
        for c in [cur, state.user?.cityName ?? ""] + hotCities where !c.isEmpty && !out.contains(c) {
            out.append(c)
        }
        return out
    }

    /// 滚轮每一格的文字（服务端给了就用服务端的，出生年份会带岁数）
    private func wheelLabels(_ q: HnQuestion) -> [String] {
        if let w = q.wheel, !w.isEmpty { return w }
        let lo = q.min ?? 0
        let hi = Swift.max(q.max ?? lo, lo)
        return (lo...hi).map { String($0) }
    }

    /// 滚轮一开始停在第几格：改答案时停在原来的值，否则停在默认值
    private func wheelStart(_ q: HnQuestion) -> Int {
        let lo = q.min ?? 0
        let n = Int(q.value?.first ?? "") ?? ((q.def ?? 0) > 0 ? (q.def ?? lo) : lo)
        return Swift.min(Swift.max(n - lo, 0), wheelLabels(q).count - 1)
    }

    // MARK: - 数据

    private func resetInput() {
        let q = current
        let old = q?.value?.first ?? ""
        let typed = !old.isEmpty && (q?.type == "text" || (q?.type == "single" && !(q?.options ?? []).contains(old)))
        input = typed ? old : ""
        picked = q?.type == "multi" ? (q?.value ?? []) : []
        if let q, q.type == "number" { wheelIdx = wheelStart(q) }
    }

    private func loadKyc() async {
        if let k: KycStatusBrief = try? await Api.request("/kyc/status") {
            needKyc = (k.required ?? false) && !(k.realname ?? false)
        }
    }

    private func load() async {
        failed = false
        do {
            let s: HnState = try await Api.request("/hn/interview")
            st = s
            if !editKey.isEmpty, (s.questions ?? []).contains(where: { $0.key == editKey }) { editing = editKey }
            await loadLink()
        } catch {
            failed = true
        }
    }

    private func submit(_ value: [String]) {
        guard let q = current, !busy else { return }
        busy = true
        inputFocused = false
        Task {
            do {
                let next: HnState = try await Api.request("/hn/interview/answer", method: "POST", body: ["key": q.key, "value": value])
                st = next
                // 出生年份 / 城市会同步到个人资料上
                if q.key == "birthYear" || q.key == "city" { await refreshMe() }
                // 从画像网页点过来改的：改完回画像网页
                if !editKey.isEmpty, editing == editKey {
                    dismiss()
                } else {
                    editing = nil
                    await loadLink()
                }
            } catch {
                toastMsg = error.localizedDescription
            }
            busy = false
        }
    }

    private func confirm() {
        guard !busy else { return }
        busy = true
        Task {
            do {
                let next: HnState = try await Api.request("/hn/interview/confirm", method: "POST")
                st = next
                toastMsg = t("hn.done")
                await refreshMe()
            } catch {
                toastMsg = error.localizedDescription
            }
            busy = false
        }
    }

    /// 全部答完以后取画像卡片要用的那几项（头像、昵称、几个标签、一句话）
    private func loadLink() async {
        guard st?.complete == true else { return }
        if let c: HnCardBrief = try? await Api.request("/hn/card/me") { link = c }
    }

    /// 「我的」页的相亲资料状态读的是全局 user，这里改完同步一下
    private func refreshMe() async {
        if let u: UserProfile = try? await Api.request("/user/me") { state.user = u }
    }
}
