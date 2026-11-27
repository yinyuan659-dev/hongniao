import AVFoundation
import SwiftUI
import PhotosUI

/// 我的
///
/// 排法照系统「设置」：整页一起滚（头像卡、相亲画像、各个分组都在同一个滚动区里），
/// 顶上是大标题「我的」，往上滑时收成顶栏中间的小标题；每一行左边一个彩色小图标，右边灰色的值和箭头；
/// 开关的说明写在分组下面的小灰字里。样稿：design/06-me.html（用户 2026-11-25 确认）。
struct MeView: View {
    @EnvironmentObject var state: AppState
    @State private var me: UserProfile?
    @State private var camDefaultOn = UserDefaults.standard.bool(forKey: "camDefaultOn")
    @State private var showScan = false
    @State private var showLanguage = false
    @State private var showUserAgreement = false
    @State private var showPrivacy = false
    @State private var toastMsg: String?
    /// 牵豆余额；nil = 还没取到
    @State private var aiBalance: String?
    /// 后台要求先做实人认证、而我还没做：显示一行「真人认证 · 未完成」（做过才能发动态 / 评论 / 视频见面）
    @State private var needKyc = false
    /// 能登录这个账号的设备有几台；nil = 还没取到
    @State private var deviceCount: Int?

    var body: some View {
        NavStack {
            content
                .background(Theme.bg2.ignoresSafeArea())
                .toast($toastMsg)
                .withRoutes()
                .navigationTitle(t("tab.me"))
                .navigationBarTitleDisplayMode(.large)
                .toolbar {
                    // 扫一扫（扫邀请名片二维码开私聊）：一直在右上角，滑到哪都能点
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button { showScan = true } label: {
                            Image(systemName: "qrcode.viewfinder").font(.system(size: 18)).foregroundStyle(Theme.accent)
                        }
                    }
                }
                // 扫一扫（统一处理见 QrViews.swift ScanHandlerModifier）
                .scanFlow(isPresented: $showScan)
                // 每次回到这一页（包括从子页面返回）都重新取一次：深聊的状态、AI 余额可能在别的页面里变了
                .onAppear {
                    Task {
                        if let u: UserProfile = try? await Api.request("/user/me") { state.user = u }
                        if let w: AiWalletBrief = try? await Api.request("/ai-wallet") { aiBalance = w.balance }
                        if let k: KycStatusBrief = try? await Api.request("/kyc/status") { needKyc = (k.required ?? false) && !(k.realname ?? false) }
                        if let d: DeviceListBrief = try? await Api.request("/devices") { deviceCount = d.devices?.count }
                    }
                }
        }
        .task {
            if let u: UserProfile = try? await Api.request("/user/me") {
                me = u
                state.user = u
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        // 优先用全局状态：编辑资料保存后（state.user 已更新）立即生效
        if let u = state.user ?? me {
            ScrollView {
                VStack(spacing: 0) {
                    whoCard(u)
                    // 我的相亲画像：基本情况（点选问答，必做）+ AI 深聊（可选）。没做完基本情况不能点喜欢、不会被推荐
                    MePortraitCard(u: u)
                        .padding(.horizontal, 16).padding(.top, 16)
                    menuGroups(u)
                    Text("\(t("app.name")) \(Self.appVersion)")
                        .font(.system(size: 12)).foregroundStyle(Theme.textDim)
                        .padding(.top, 22)
                    // App 的 ICP 备案号：点了用系统浏览器（Safari）打开工信部的备案查询网站，不在 App 里开
                    Link(destination: Api.icpQueryURL) {
                        Text(Api.appIcpNo)
                            .font(.system(size: 12)).foregroundStyle(Theme.textDim)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .contentShape(Rectangle())
                    }
                    .padding(.top, 2)
                }
                .padding(.top, 4).padding(.bottom, 28)
            }
        } else {
            EmptyHint(text: t("common.loading"))
        }
    }

    private static var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    }

    // MARK: - 第一张卡：我是谁

    /// 头像、昵称、「真人认证」标；一行灰字（性别年龄 · 城市 · ID，点 ID 复制）；一行签名。点这张卡进「基本资料」。下半部分是关注 / 粉丝
    private func whoCard(_ u: UserProfile) -> some View {
        VStack(spacing: 0) {
            RouteLink(.editProfile) {
                HStack(spacing: 14) {
                    AvatarView(url: u.avatar, size: 62)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 7) {
                            Text(u.nickname).font(.system(size: 20, weight: .bold)).foregroundStyle(Theme.text).lineLimit(1)
                            if u.realname == true {
                                Text("真人认证").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
                                    .padding(.horizontal, 7).padding(.vertical, 2)
                                    .background(Capsule().fill(Color(red: 0.204, green: 0.78, blue: 0.349)))
                                    .fixedSize()
                            }
                        }
                        HStack(spacing: 0) {
                            Text(aboutLine(u)).font(.system(size: 13)).foregroundStyle(Theme.textSub).lineLimit(1)
                            if let sid = u.shortId {
                                // 点 ID 这一小段是复制，不进「基本资料」
                                HStack(spacing: 4) {
                                    Text(" · " + t("me.id", ["id": sid])).font(.system(size: 13)).foregroundStyle(Theme.textSub).lineLimit(1)
                                    Image(systemName: "doc.on.doc").font(.system(size: 10)).foregroundStyle(Theme.textSub)
                                }
                                .contentShape(Rectangle())
                                .highPriorityGesture(TapGesture().onEnded { _ in
                                    UIPasteboard.general.string = sid
                                    toastMsg = t("common.copied")
                                })
                            }
                        }
                        Text(u.signature.isEmpty ? t("me.noSignature") : u.signature)
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    chevron
                }
                .padding(.horizontal, 16).padding(.vertical, 14)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Rectangle().fill(Theme.line).frame(height: 0.5)
            // 点击进关注 / 粉丝列表
            HStack(spacing: 0) {
                RouteLink(.followList("following")) { stat(u.following ?? 0, t("me.following")) }.buttonStyle(.plain)
                Rectangle().fill(Theme.line).frame(width: 0.5, height: 22)
                RouteLink(.followList("fans")) { stat(u.fans ?? 0, t("me.fans")) }.buttonStyle(.plain)
            }
        }
        .background(Theme.bg)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 16)
    }

    /// 「女 27 · 成都」；没选城市就不写城市
    private func aboutLine(_ u: UserProfile) -> String {
        var s = "\(u.gender == 1 ? t("me.male") : t("me.female")) \(u.age)"
        if !u.cityName.isEmpty { s += " · \(u.cityName)" }
        return s
    }

    private func stat(_ n: Int, _ label: String) -> some View {
        HStack(spacing: 5) {
            Text("\(n)").font(.system(size: 17, weight: .bold)).foregroundStyle(Theme.text)
            Text(label).font(.system(size: 13)).foregroundStyle(Theme.textSub)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 11)
        .contentShape(Rectangle())
    }

    // MARK: - 功能分组

    /// 我的内容 / AI 费用 / 账号与安全 / 工具 / 设置 / 关于
    private func menuGroups(_ u: UserProfile) -> some View {
        VStack(spacing: 0) {
            meGroup(t("me.group.content")) {
                navRow("photo.fill", .orange, t("me.myMoments"), route: .myMoments, first: true)
            }
            // 牵豆（原来叫 AI 余额，1 元 = 1 牵豆）：视频见面、AI 功能、真人认证都从这里扣；点进去是网页
            meGroup("牵豆") {
                navRow("creditcard.fill", Self.green, "我的牵豆", value: aiBalance, route: .web("/ai-fee"), first: true)
            }
            // 账号与安全：真人认证（后台要求且还没做时才出现）、登录设备（换手机刷脸找回后会多出来，可以移除）；点进去都是网页
            meGroup("账号与安全", footer: needKyc ? "做过真人认证才能发动态、评论、视频见面。认证一次 1 牵豆。" : nil) {
                if needKyc {
                    navRow("checkmark.shield.fill", .orange, "真人认证", value: "未完成", dot: true, route: .web("/kyc?next=/me"), first: true)
                }
                navRow("lock.fill", .blue, "登录设备", value: deviceCount.map { "\($0) 台" }, route: .web("/devices"), first: !needKyc)
            }
            // 专属邀请网页（链接 + 二维码）：女生发给男生 / 男生发给女生，下载后自动归因到我
            meGroup(t("me.group.tools")) {
                navRow("link", .purple, t("me.inviteCard"), route: .inviteCard, first: true)
            }
            meGroup(t("me.group.settings"), footer: settingsFooter(u)) {
                // 相亲资料 = AI 红娘的那页问答（头像 / 昵称 / 照片墙在最上面那张卡里改）
                navRow("heart.fill", Theme.accent, "相亲资料", value: u.profileDone == true ? "已填完" : "未填完", route: .interview, first: true)
                videoMeetRow
                // 男方专属：视频通话默认是否开启自己画面（默认关闭；女方无此设置）
                if u.gender == 1 { camRow }
                languageRow
            }
            meGroup(t("me.group.about")) {
                Button { showUserAgreement = true } label: {
                    cell("doc.text.fill", .gray, t("agreement.userTitle"), first: true) { chevron }
                }
                .buttonStyle(.plain)
                .sheet(isPresented: $showUserAgreement) { AgreementSheet(isPrivacy: false) }
                Button { showPrivacy = true } label: {
                    cell("hand.raised.fill", .gray, t("agreement.privacyTitle")) { chevron }
                }
                .buttonStyle(.plain)
                .sheet(isPresented: $showPrivacy) { AgreementSheet(isPrivacy: true) }
            }
        }
    }

    private static let green = Color(red: 0.204, green: 0.78, blue: 0.349)

    /// 开关的说明：写在「设置」这一组下面
    private func settingsFooter(_ u: UserProfile) -> String {
        var s = "\(t("me.videoMeet"))：\(t("me.videoMeetSub"))"
        if u.gender == 1 { s += "\n\(t("me.camDefault"))：\(t("me.camDefaultSub"))" }
        return s
    }

    /// 小标题 + 白色圆角卡片 + （可选）下面一行小灰字说明
    private func meGroup<C: View>(_ title: String, footer: String? = nil, @ViewBuilder _ rows: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                .padding(.leading, 16).padding(.bottom, 7)
            VStack(spacing: 0) { rows() }
                .background(Theme.bg)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            if let footer {
                Text(footer).font(.system(size: 12)).foregroundStyle(Theme.textSub).lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16).padding(.top, 7)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.top, 22)
    }

    /// 一行：彩色小图标 + 名字 + 右边的东西（值和箭头 / 开关）。第一行上面不画分隔线，分隔线从文字开始的位置画起
    private func cell<V: View>(_ icon: String, _ color: Color, _ title: String, first: Bool = false, @ViewBuilder trailing: () -> V) -> some View {
        VStack(spacing: 0) {
            if !first { Rectangle().fill(Theme.line).frame(height: 0.5).padding(.leading, 57) }
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: 29, height: 29)
                    .background(RoundedRectangle(cornerRadius: 7).fill(color))
                Text(title).font(.system(size: 16)).foregroundStyle(Theme.text).lineLimit(1)
                Spacer(minLength: 8)
                trailing()
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 46)
        }
        // 让整行（含空白区域）都可点击
        .contentShape(Rectangle())
    }

    private var chevron: some View {
        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.textDim)
    }

    /// 右边：（橙色小点）+ 灰色的值 + 箭头
    private func valueChevron(_ value: String?, dot: Bool = false) -> some View {
        HStack(spacing: 7) {
            if dot { Circle().fill(Color.orange).frame(width: 8, height: 8) }
            if let value { Text(value).font(.system(size: 15)).foregroundStyle(Theme.textSub).lineLimit(1) }
            chevron
        }
    }

    /// 点了跳到另一页的一行
    private func navRow(_ icon: String, _ color: Color, _ title: String, value: String? = nil, dot: Bool = false, route: Route, first: Bool = false) -> some View {
        RouteLink(route) {
            cell(icon, color, title, first: first) { valueChevron(value, dot: dot) }
        }
        .buttonStyle(.plain)
    }

    /// 视频见面：默认关，自己和对方都打开才能互相发起视频通话
    private var videoMeetRow: some View {
        cell("video.fill", Color(red: 0.353, green: 0.784, blue: 0.98), t("me.videoMeet")) {
            Toggle("", isOn: Binding(
                get: { state.user?.allowVideo == true },
                set: { on in
                    state.user?.allowVideo = on
                    Task {
                        // 没存上就拨回去
                        let saved: UserProfile? = try? await Api.request("/user/me", method: "PUT", body: ["allowVideo": on])
                        if saved == nil { state.user?.allowVideo = !on }
                    }
                }
            ))
            .labelsHidden()
            .tint(Theme.accent)
        }
    }

    private var camRow: some View {
        cell("camera.fill", Color(red: 0.345, green: 0.337, blue: 0.839), t("me.camDefault")) {
            Toggle("", isOn: $camDefaultOn)
                .labelsHidden()
                .tint(Theme.accent)
                .onChange(of: camDefaultOn) { v in
                    UserDefaults.standard.set(v, forKey: "camDefaultOn")
                }
        }
    }

    /// 语言：跟随系统 + 打包进来的每种语言（名字用各自的语言写）
    private var languageRow: some View {
        let i18n = I18n.shared
        let current = i18n.choice == I18n.system ? t("lang.system") : (i18n.languages.first { $0.code == i18n.choice }?.name ?? i18n.choice)
        return Button {
            showLanguage = true
        } label: {
            cell("globe", .gray, t("lang.title")) { valueChevron(current) }
        }
        .buttonStyle(.plain)
        .confirmationDialog(t("lang.title"), isPresented: $showLanguage, titleVisibility: .visible) {
            Button(t("lang.system")) { i18n.select(I18n.system) }
            ForEach(i18n.languages, id: \.code) { l in
                Button(l.name) { i18n.select(l.code) }
            }
        }
    }
}

/// 实名认证（仅女生）：姓名 + 身份证号，后端本地核验校验位，一证一号
struct RealnameView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var idCard = ""
    @State private var busy = false
    @State private var toastMsg: String?

    private var verified: Bool { state.user?.realname == true }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if verified {
                    VStack(spacing: 10) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 44)).foregroundStyle(Theme.success)
                        Text(t("realname.done")).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                        Text(t("realname.verifiedName", ["name": state.user?.realNameMasked ?? ""]))
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))
                } else {
                    VStack(alignment: .leading, spacing: 14) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(t("realname.name")).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                            TextField("", text: $name, prompt: Text(t("realname.namePlaceholder")).foregroundColor(Theme.textDim))
                                .font(.system(size: 16)).foregroundStyle(Theme.text)
                                .padding(12)
                                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text(t("realname.idCardNo")).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                            TextField("", text: $idCard, prompt: Text(t("realname.idCardPlaceholder")).foregroundColor(Theme.textDim))
                                .font(.system(size: 16, design: .monospaced)).foregroundStyle(Theme.text)
                                .textInputAutocapitalization(.characters)
                                .autocorrectionDisabled()
                                .padding(12)
                                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                                .onChange(of: idCard) { v in
                                    let filtered = String(v.uppercased().filter { $0.isNumber || $0 == "X" }.prefix(18))
                                    if filtered != v { idCard = filtered }
                                }
                        }
                        Text(t("realname.privacy"))
                            .font(.system(size: 12)).foregroundStyle(Theme.textDim)
                    }
                    .padding(18)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))

                    AccentButton(title: busy ? t("realname.submitting") : t("realname.submit"), enabled: !busy && name.count >= 2 && idCard.count == 18) {
                        Task { await submit() }
                    }
                }
            }
            .padding(16)
        }
        .fullBg()
        .navigationTitle(t("realname.title"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toast($toastMsg)
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        do {
            struct OkResp: Codable { var ok: Bool? }
            let _: OkResp = try await Api.request("/user/realname", method: "POST", body: [
                "name": name.trimmingCharacters(in: .whitespaces),
                "idCard": idCard,
            ])
            if let u: UserProfile = try? await Api.request("/user/me") { state.user = u }
            toastMsg = t("realname.success")
        } catch {
            toastMsg = error.localizedDescription
        }
    }
}

/// 编辑资料
struct EditProfileView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var nickname = ""
    @State private var age = 18
    @State private var avatar = ""
    @State private var signature = ""
    @State private var city = ""
    @State private var toastMsg: String?
    @State private var loaded = false
    /// 照片墙（最多 8 张，支持多选）
    @State private var photos: [String] = []
    @State private var uploadingPhoto = false
    /// 年纪滚轮选择（底部弹层）
    @State private var showAgeSheet = false
    @State private var pendingAge = 18

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                // ===== 头像 =====
                CompatPhotoPicker(kind: .images, onPicked: { datas in
                    guard let data = datas.first else { return }
                    Task {
                        if let url = try? await Api.upload("image", data: data, filename: "avatar.jpg", mime: "image/jpeg") {
                            avatar = url
                        }
                    }
                }) {
                    VStack(spacing: 8) {
                        ZStack(alignment: .bottom) {
                            AvatarView(url: avatar, size: 92)
                            Text(t("profile.change"))
                                .font(.system(size: 10)).foregroundStyle(.white)
                                .padding(.horizontal, 10).padding(.vertical, 2)
                                .background(Capsule().fill(Color.black.opacity(0.55)))
                        }
                        Text(t("profile.changeAvatar")).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    }
                }
                .padding(.top, 10)

                // ===== 基本信息 =====
                editCard {
                    editRow(t("profile.nickname")) {
                        TextField(t("profile.nicknameHint"), text: $nickname)
                            .font(.system(size: 15)).foregroundStyle(Theme.text)
                    }
                    editDivider
                    editRow(t("profile.age")) {
                        HStack {
                            Text(t("profile.ageYears", ["n": age])).font(.system(size: 15)).foregroundStyle(Theme.text)
                            Spacer()
                            Text("›").font(.system(size: 20)).foregroundStyle(Theme.textDim)
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { pendingAge = age; showAgeSheet = true }
                    editDivider
                    editRow(t("profile.city")) {
                        HStack(spacing: 10) {
                            TextField(t("profile.cityHint"), text: $city)
                                .font(.system(size: 15)).foregroundStyle(Theme.text)
                            Button(t("profile.locate")) {
                                CityLocator.shared.detect { name in
                                    DispatchQueue.main.async { if let name { city = name } }
                                }
                            }
                            .font(.system(size: 13)).foregroundStyle(Theme.accent)
                        }
                    }
                }

                // ===== 签名 =====
                editCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(t("profile.bio")).font(.system(size: 14)).foregroundStyle(Theme.textSub)
                        CompatVerticalTextField(text: $signature, prompt: Text(t("profile.bioPlaceholder")), lineRange: 3...6)
                            .font(.system(size: 15)).foregroundStyle(Theme.text)
                            .onChange(of: signature) { v in
                                if v.count > 80 { signature = String(v.prefix(80)) }
                            }
                        Text("\(signature.count)/80")
                            .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    .padding(.vertical, 14)
                }

                // ===== 照片墙：最多 8 张，展示在个人主页 =====
                editCard {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(t("profile.photoWall")).font(.system(size: 14)).foregroundStyle(Theme.textSub)
                            Spacer()
                            Text("\(photos.count)/8")
                                .font(.system(size: 12))
                                .foregroundStyle(photos.count >= 8 ? Theme.accent : Theme.textDim)
                        }
                        Text(photos.count >= 8
                            ? t("profile.wallFull")
                            : t("profile.wallRemain", ["n": 8 - photos.count]))
                            .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                        let cols = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
                        LazyVGrid(columns: cols, spacing: 8) {
                            ForEach(Array(photos.enumerated()), id: \.offset) { idx, url in
                                ZStack(alignment: .topTrailing) {
                                    Color.clear
                                        .aspectRatio(1, contentMode: .fit)
                                        .overlay(RemoteImage(url: url).aspectRatio(contentMode: .fill))
                                        .clipShape(RoundedRectangle(cornerRadius: 10))
                                    Button {
                                        photos.remove(at: idx)
                                    } label: {
                                        Text("✕").font(.system(size: 11)).foregroundStyle(.white)
                                            .frame(width: 20, height: 20)
                                            .background(Circle().fill(Color.black.opacity(0.55)))
                                    }
                                    .buttonStyle(.plain)
                                    .padding(4)
                                }
                            }
                            if photos.count < 8 {
                                // 多选：一次最多选剩余可加张数
                                CompatPhotoPicker(kind: .images, maxCount: 8 - photos.count, onPicked: { datas in
                                    uploadingPhoto = true
                                    Task {
                                        for data in datas where photos.count < 8 {
                                            if let url = try? await Api.upload("image", data: data, filename: "wall.jpg", mime: "image/jpeg") {
                                                photos.append(url)
                                            }
                                        }
                                        uploadingPhoto = false
                                    }
                                }) {
                                    RoundedRectangle(cornerRadius: 10).fill(Theme.bg3)
                                        .aspectRatio(1, contentMode: .fit)
                                        .overlay(Text(uploadingPhoto ? "…" : "＋").font(.system(size: 26)).foregroundStyle(Theme.textDim))
                                }
                            }
                        }
                    }
                    .padding(.vertical, 14)
                }

                Spacer(minLength: 30)
            }
            .padding(.horizontal, 16)
        }
        .fullBg()
        .navigationTitle(t("me.editProfile"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(t("common.save")) { save() }
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.accent)
            }
        }
        // 年纪滚轮：底部弹层，取消/确定
        .sheet(isPresented: $showAgeSheet) {
            VStack(spacing: 0) {
                HStack {
                    Button(t("common.cancel")) { showAgeSheet = false }
                        .font(.system(size: 14)).foregroundStyle(Theme.textSub)
                    Spacer()
                    Text(t("profile.pickAge")).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                    Spacer()
                    Button(t("common.ok")) { age = pendingAge; showAgeSheet = false }
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.accent)
                }
                .padding(16)
                Picker("", selection: $pendingAge) {
                    ForEach(18...70, id: \.self) {
                        Text("\($0)").foregroundStyle(Theme.text).tag($0)
                    }
                }
                .pickerStyle(.wheel)
            }
            .compatDetents(height: 300)
            .compatSheetBackground(Theme.bg2)
        }
        .toast($toastMsg)
        .onAppear {
            guard !loaded, let u = state.user else { return }
            nickname = u.nickname; age = max(18, u.age); avatar = u.avatar
            signature = u.signature; city = u.cityName
            photos = (u.albums ?? []).filter { ($0.type ?? 1) == 1 }.map(\.url)
            loaded = true
        }
    }

    /// 编辑资料分组卡片（bg2 圆角）
    private func editCard(@ViewBuilder content: () -> some View) -> some View {
        VStack(spacing: 0) { content() }
            .padding(.horizontal, 14)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))
            .padding(.top, 14)
    }

    /// 编辑资料行：左标签 + 右内容
    private func editRow(_ label: String, @ViewBuilder content: () -> some View) -> some View {
        HStack(spacing: 0) {
            Text(label).font(.system(size: 14)).foregroundStyle(Theme.textSub)
                .frame(width: 76, alignment: .leading)
            content().frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 15)
    }

    private var editDivider: some View {
        Rectangle().fill(Theme.line).frame(height: 0.5)
    }

    private func save() {
        guard !nickname.trimmingCharacters(in: .whitespaces).isEmpty else {
            toastMsg = t("profile.nicknameEmpty")
            return
        }
        Task {
            let body: [String: Any] = [
                "nickname": nickname.trimmingCharacters(in: .whitespaces),
                "age": age,
                "avatar": avatar,
                "signature": signature.trimmingCharacters(in: .whitespaces),
                "cityName": city,
                "cityCode": city,
            ]
            do {
                let _: UserProfile = try await Api.request("/user/me", method: "PUT", body: body)
                // 照片墙整组保存
                struct OkResp: Codable { var ok: Bool? }
                let _: OkResp = try await Api.request("/user/albums", method: "PUT", body: ["photos": photos])
                // 重新拉取带照片墙的完整资料
                if let u: UserProfile = try? await Api.request("/user/me") { state.user = u }
                dismiss()
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }
}

/// 关注/粉丝列表条目（GET /user/follows/list）
struct FollowUser: Codable, Identifiable, Hashable {
    var id: String = "0"
    var nickname: String? = ""
    var avatar: String? = ""
    var age: Int? = 0
    var gender: Int? = 1
    var cityName: String? = ""
    var signature: String? = ""
    var isGuide: Bool? = false
}

/// 关注/粉丝列表（我的页面点击数字进入）
struct FollowListView: View {
    let type: String
    @State private var list: [FollowUser]?

    var body: some View {
        Group {
            if let list {
                if list.isEmpty {
                    Text(type == "fans" ? t("me.noFans") : t("me.noFollowing"))
                        .font(.system(size: 13)).foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(list) { u in
                                RouteLink(.userHome(u.id)) {
                                    HStack(spacing: 12) {
                                        AvatarView(url: u.avatar, size: 46)
                                        VStack(alignment: .leading, spacing: 3) {
                                            HStack(spacing: 6) {
                                                Text(u.nickname ?? "").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                                                if u.isGuide == true {
                                                    Text(t("me.verified")).font(.system(size: 10)).foregroundStyle(Theme.accent)
                                                        .padding(.horizontal, 5).padding(.vertical, 1)
                                                        .background(RoundedRectangle(cornerRadius: 3).fill(Theme.accent.opacity(0.12)))
                                                }
                                            }
                                            let sub = (u.signature?.isEmpty == false) ? (u.signature ?? "") : (u.cityName ?? "")
                                            if !sub.isEmpty {
                                                Text(sub).font(.system(size: 12)).foregroundStyle(Theme.textSub).lineLimit(1)
                                            }
                                        }
                                        Spacer()
                                        Text("›").font(.system(size: 18)).foregroundStyle(Theme.textDim)
                                    }
                                    .padding(.horizontal, 16).padding(.vertical, 12)
                                }
                                .buttonStyle(.plain)
                                Rectangle().fill(Theme.line).frame(height: 0.5).padding(.leading, 74)
                            }
                        }
                    }
                }
            } else {
                Text(t("common.loading")).font(.system(size: 13)).foregroundStyle(Theme.textDim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .fullBg()
        .navigationTitle(type == "fans" ? t("me.fans") : t("me.following"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .task {
            list = (try? await Api.request("/user/follows/list?type=\(type)")) ?? []
        }
    }
}
