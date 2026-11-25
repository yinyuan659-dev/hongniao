import AVFoundation
import SwiftUI
import PhotosUI

/// 我的
struct MeView: View {
    @EnvironmentObject var state: AppState
    @State private var me: UserProfile?
    @State private var camDefaultOn = UserDefaults.standard.bool(forKey: "camDefaultOn")
    @State private var showScan = false
    @State private var showLanguage = false
    /// AI 余额（元）；nil = 还没取到
    @State private var aiBalance: String?
    /// 后台要求先做实人认证、而我还没做：显示一行「完成实人认证」（做过才能聊天 / 发动态 / 评论）
    @State private var needKyc = false
    /// 能登录这个账号的设备有几台；nil = 还没取到
    @State private var deviceCount: Int?

    var body: some View {
        NavStack {
            content
                .fullBg()
                .withRoutes()
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
            // 头部（头像到相亲资料卡）固定不动，下面的功能分组单独滚动
            VStack(spacing: 0) {
                    // 头部
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(alignment: .top, spacing: 16) {
                            AvatarView(url: u.avatar, size: 76)
                            VStack(alignment: .leading, spacing: 8) {
                                Text(u.nickname).font(.system(size: 21, weight: .bold)).foregroundStyle(Theme.text)
                                HStack(spacing: 6) {
                                    Text("\(u.gender == 1 ? t("me.male") : t("me.female")) \(u.age)")
                                        .font(.system(size: 11))
                                        .foregroundStyle(u.gender == 1 ? Color(red: 0.43, green: 0.70, blue: 1.0) : Color(red: 1.0, green: 0.48, blue: 0.58))
                                        .padding(.horizontal, 10).padding(.vertical, 2)
                                        .background(Capsule().fill(Theme.bg3))
                                    if u.isGuide {
                                        Text(t("me.verified")).font(.system(size: 11)).foregroundStyle(Theme.accent)
                                            .padding(.horizontal, 8).padding(.vertical, 2)
                                            .background(RoundedRectangle(cornerRadius: 4).fill(Theme.bg3))
                                    }
                                }
                                if let sid = u.shortId {
                                    Text(t("me.id", ["id": sid])).font(.system(size: 12)).foregroundStyle(Theme.textSub)
                                }
                            }
                            .padding(.top, 4)
                            Spacer()
                            // 扫一扫（扫邀请名片二维码开私聊）
                            Button {
                                showScan = true
                            } label: {
                                Image(systemName: "qrcode.viewfinder")
                                    .font(.system(size: 17))
                                    .foregroundStyle(Theme.text)
                                    .frame(width: 38, height: 38)
                                    .background(Circle().fill(Theme.bg3))
                            }
                            .buttonStyle(.plain)
                            .padding(.top, 4)
                        }
                        Text(u.signature.isEmpty ? t("me.noSignature") : u.signature)
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                            .padding(.top, 14)
                        // 点击进关注/粉丝列表
                        HStack(spacing: 6) {
                            RouteLink(.followList("following")) {
                                HStack(spacing: 6) {
                                    Text("\(u.following ?? 0)").font(.system(size: 17, weight: .bold)).foregroundStyle(Theme.text)
                                    Text(t("me.following")).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                                }
                            }
                            .buttonStyle(.plain)
                            Spacer().frame(width: 14)
                            RouteLink(.followList("fans")) {
                                HStack(spacing: 6) {
                                    Text("\(u.fans ?? 0)").font(.system(size: 17, weight: .bold)).foregroundStyle(Theme.text)
                                    Text(t("me.fans")).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.top, 16)

                        // 我的相亲画像：基本情况（点选问答，必做）+ AI 深聊（可选）。没做完基本情况不能主动找人聊天
                        MePortraitCard(u: u)
                            .padding(.top, 16)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(EdgeInsets(top: 28, leading: 20, bottom: 16, trailing: 20))
                    .background(LinearGradient(colors: [Theme.accent.opacity(0.14), Theme.bg], startPoint: .top, endPoint: .bottom))

                    Rectangle().fill(Theme.line).frame(height: 1)
                    ScrollView {
                        menuGroups(u).padding(.bottom, 24)
                    }
                    .background(Theme.bg2)
            }
        } else {
            EmptyHint(text: t("common.loading"))
        }
    }

    /// 功能分组：我的内容 / 工具 / 设置
    private func menuGroups(_ u: UserProfile) -> some View {
        VStack(spacing: 0) {
            meGroup(t("me.group.content")) {
                menuRow(t("me.myMoments"), .myMoments, first: true)
            }
            // AI 费用：深聊这类 AI 功能按用量花模型费（平台余额或自己的 Key）；点进去是网页
            meGroup("AI 费用") {
                RouteLink(.web("/ai-fee")) {
                    HStack {
                        Text("AI 余额").font(.system(size: 15)).foregroundStyle(Theme.text)
                        Spacer()
                        if let aiBalance { Text("¥\(aiBalance)").font(.system(size: 14)).foregroundStyle(Theme.textSub) }
                        Text("›").font(.system(size: 18)).foregroundStyle(Theme.textDim)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 14)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            // 账号与安全：实人认证（后台要求且还没做时才出现）、登录设备（换手机刷脸找回后会多出来，可以移除）；点进去都是网页
            meGroup("账号与安全") {
                if needKyc {
                    webRow("完成实人认证", value: "做过才能聊天 · ¥1", route: "/kyc?next=/me")
                    Rectangle().fill(Theme.line).frame(height: 0.5).padding(.leading, 16)
                }
                webRow("登录设备", value: deviceCount.map { "\($0) 台" }, route: "/devices")
            }
            // 专属邀请网页（链接 + 二维码）：女生发给男生 / 男生发给女生，下载后自动归因到我
            meGroup(t("me.group.tools")) {
                menuRow(t("me.inviteCard"), .inviteCard, first: true)
            }
            meGroup(t("me.group.settings")) {
                // 编辑资料 = 进 AI 红娘的资料收集；头像 / 昵称 / 照片墙单独一行
                menuRow(t("me.editProfile"), .interview, first: true)
                menuRow(t("hn.basic"), .editProfile)
                videoMeetRow
                languageRow
                // 男方专属：视频通话默认是否开启自己画面（默认关闭；女方无此设置）
                if u.gender == 1 { camRow }
            }
        }
    }

    /// 点开是内嵌网页的一行：左边名字，右边一个灰色的值和箭头
    private func webRow(_ title: String, value: String?, route: String) -> some View {
        RouteLink(.web(route)) {
            HStack {
                Text(title).font(.system(size: 15)).foregroundStyle(Theme.text)
                Spacer()
                if let value { Text(value).font(.system(size: 14)).foregroundStyle(Theme.textSub) }
                Text("›").font(.system(size: 18)).foregroundStyle(Theme.textDim)
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// 小标题 + 白色圆角卡片
    private func meGroup<C: View>(_ title: String, @ViewBuilder _ rows: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 12)).foregroundStyle(Theme.textSub).padding(.leading, 6)
            VStack(spacing: 0) { rows() }
                .background(Theme.bg)
                .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .padding(.horizontal, 16).padding(.top, 16)
    }

    /// 卡片里行与行之间的分隔线（左边缩进，第一行上面不画）
    private var rowDivider: some View {
        Rectangle().fill(Theme.line).frame(height: 0.5).padding(.leading, 16)
    }

    /// 视频见面：默认关，自己和对方都打开才能互相发起视频通话
    private var videoMeetRow: some View {
        VStack(spacing: 0) {
            rowDivider
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(t("me.videoMeet")).font(.system(size: 15)).foregroundStyle(Theme.text)
                    Text(t("me.videoMeetSub")).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                }
                Spacer()
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
            .padding(.horizontal, 16).padding(.vertical, 10)
        }
    }

    private var camRow: some View {
        VStack(spacing: 0) {
            rowDivider
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(t("me.camDefault")).font(.system(size: 15)).foregroundStyle(Theme.text)
                    Text(t("me.camDefaultSub")).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                }
                Spacer()
                Toggle("", isOn: $camDefaultOn)
                    .labelsHidden()
                    .tint(Theme.accent)
                    .onChange(of: camDefaultOn) { v in
                        UserDefaults.standard.set(v, forKey: "camDefaultOn")
                    }
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
        }
    }

    /// 语言：跟随系统 + 打包进来的每种语言（名字用各自的语言写）
    private var languageRow: some View {
        let i18n = I18n.shared
        let current = i18n.choice == I18n.system ? t("lang.system") : (i18n.languages.first { $0.code == i18n.choice }?.name ?? i18n.choice)
        return Button {
            showLanguage = true
        } label: {
            VStack(spacing: 0) {
                rowDivider
                HStack {
                    Text(t("lang.title")).font(.system(size: 15)).foregroundStyle(Theme.text)
                    Spacer()
                    Text(current).font(.system(size: 14)).foregroundStyle(Theme.textSub)
                    Text("›").font(.system(size: 18)).foregroundStyle(Theme.textDim)
                }
                .padding(.horizontal, 16).padding(.vertical, 14)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .confirmationDialog(t("lang.title"), isPresented: $showLanguage, titleVisibility: .visible) {
            Button(t("lang.system")) { i18n.select(I18n.system) }
            ForEach(i18n.languages, id: \.code) { l in
                Button(l.name) { i18n.select(l.code) }
            }
        }
    }

    private func menuRow(_ label: String, _ route: Route, first: Bool = false) -> some View {
        RouteLink(route) {
            VStack(spacing: 0) {
                if !first { rowDivider }
                HStack {
                    Text(label).font(.system(size: 15)).foregroundStyle(Theme.text)
                    Spacer()
                    Text("›").font(.system(size: 18)).foregroundStyle(Theme.textDim)
                }
                .padding(.horizontal, 16).padding(.vertical, 14)
            }
            // 让整行（含空白区域）都可点击
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
