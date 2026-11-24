import SwiftUI
import UIKit
import PhotosUI
import CoreLocation
import AVFoundation
import AVKit

/// 快速起播的播放器：小前向缓冲 + 不等待最小卡顿缓冲，点开即播
func makeFastStartPlayer(url: URL) -> AVPlayer {
    let item = AVPlayerItem(url: url)
    // 缓冲 2 秒即可起播（默认策略会等更久）
    item.preferredForwardBufferDuration = 2
    let player = AVPlayer(playerItem: item)
    player.automaticallyWaitsToMinimizeStalling = false
    return player
}

/// 全局视频播放中心：保证同时只有一个视频出声
enum FeedVideoCenter {
    static weak var current: AVPlayer?
    static func play(_ player: AVPlayer) {
        if current !== player { current?.pause() }
        current = player
        player.play()
    }

    /// 离开页面（切 tab / 打开弹层 / 进详情）时调用
    static func pauseCurrent() {
        current?.pause()
    }
}

/// 广场：动态 / 遇见（只看得到异性，服务端强制）
struct PlazaView: View {
    /// 手动选过的城市存在本机：下次打开直接用，不再被自动定位覆盖（和网页端 localStorage 的做法一致）
    private static let cityKey = "hn_plaza_city"

    @State private var tab = "feed"
    @State private var items: [Moment] = []
    @State private var city = UserDefaults.standard.string(forKey: PlazaView.cityKey) ?? ""
    @State private var locating = false
    @State private var showCity = false
    @State private var myLocation: CLLocation?

    var body: some View {
        NavStack {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    HStack(spacing: 16) {
                        TextTab(text: t("plaza.tab.feed"), selected: tab == "feed") { tab = "feed"; Task { await load() } }
                        TextTab(text: t("plaza.tab.meet"), selected: tab == "meet") { tab = "meet" }
                    }
                    Spacer()
                    // 点城市：弹城市选择（里面第一格是当前定位）
                    Button(locating ? t("plaza.locating") : (city.isEmpty ? t("plaza.locate") : "\(city) ▾")) { showCity = true }
                        .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                        .lineLimit(1).fixedSize()
                        .layoutPriority(1)
                }
                .padding(.horizontal, 16).padding(.vertical, 12)

                if tab == "meet" {
                    // 遇见：异性卡片流（所有/新人/同城/亲密度）
                    MeetSectionView(city: city)
                } else if items.isEmpty {
                    EmptyHint(text: t("plaza.emptyFeed"))
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(items) { m in
                                // 视频点封面原地播放（抖音模式已下线，不传 onOpenVideo）
                                MomentCardView(m: m, viewerLocation: myLocation, onVideoCall: { user in
                                    startCallWithPermissions(calleeId: user.id, type: 2, name: user.nickname ?? "", avatar: user.avatar ?? "")
                                })
                            }
                        }
                    }
                    .refreshable { await load() }
                }
            }
            .fullBg()
            .withRoutes()
        }
        .sheet(isPresented: $showCity) {
            CityPickerSheet(current: city) { picked in
                city = picked
                UserDefaults.standard.set(picked, forKey: PlazaView.cityKey)
                showCity = false
            }
        }
        .onChange(of: showCity) { shown in
            // 打开弹层时停止列表内视频
            if shown { FeedVideoCenter.pauseCurrent() }
        }
        .task {
            locate()
            await load()
            // 在线状态兜底：每 30 秒静默刷新（保持顺序不跳动）
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                await load(silent: true)
            }
        }
    }

    /// 定位：经纬度总是更新（算距离用）；城市只在没手动选过时才用定位结果
    private func locate() {
        locating = city.isEmpty
        CityLocator.shared.detectWithLocation { name, loc in
            DispatchQueue.main.async {
                if city.isEmpty { city = name ?? "" }
                myLocation = loc ?? myLocation
                locating = false
            }
        }
    }

    private func load(silent: Bool = false) async {
        if tab != "feed" { return }
        guard let fresh: [Moment] = try? await Api.request("/moments/feed") else { return }
        if silent, !items.isEmpty {
            // 静默刷新：保持当前顺序只更新数据（在线状态等），避免列表跳动
            let freshMap = Dictionary(uniqueKeysWithValues: fresh.map { ($0.id, $0) })
            let kept = items.compactMap { freshMap[$0.id] }
            let added = fresh.filter { f in !items.contains(where: { $0.id == f.id }) }
            items = kept + added
        } else {
            items = fresh
        }
    }
}

/// 城市选择（对齐网页端 CityPickerSheet）：定位 + 热门 + 字母分组列表 + 右侧 A-Z 索引
struct CityPickerSheet: View {
    let current: String
    var onSelect: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var located: String?
    @State private var locating = true
    @State private var activeLetter = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(t("city.choose")).font(.system(size: 17, weight: .bold)).foregroundStyle(Theme.text)
                Spacer()
                Button(t("common.close")) { dismiss() }
                    .font(.system(size: 14)).foregroundStyle(Theme.textSub)
            }
            .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 10)

            ScrollViewReader { proxy in
                ZStack(alignment: .trailing) {
                    ScrollView(showsIndicators: false) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            hotBlock.id("#")
                            ForEach(cityLetters) { group in
                                Text(group.letter)
                                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.textSub)
                                    .padding(.top, 16).padding(.bottom, 6)
                                    .id(group.letter)
                                ForEach(group.cities, id: \.self) { name in
                                    Button { onSelect(name) } label: {
                                        VStack(alignment: .leading, spacing: 0) {
                                            Text(name).font(.system(size: 15))
                                                .foregroundStyle(name == current ? Theme.accent : Theme.text)
                                                .frame(maxWidth: .infinity, alignment: .leading)
                                                .padding(.horizontal, 4).padding(.vertical, 12)
                                            Rectangle().fill(Theme.line).frame(height: 0.5)
                                        }
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .padding(.leading, 16).padding(.trailing, 40).padding(.bottom, 24)
                    }

                    // 右侧字母索引：点字母跳到那一组，# 回到顶部
                    VStack(spacing: 1) {
                        ForEach(["#"] + cityLetters.map(\.letter), id: \.self) { l in
                            Text(l).font(.system(size: 10))
                                .foregroundStyle(activeLetter == l ? Color.white : Theme.textSub)
                                .frame(width: 16, height: 15)
                                .background(Capsule().fill(activeLetter == l ? Theme.accent : Color.clear))
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    activeLetter = l
                                    proxy.scrollTo(l, anchor: .top)
                                }
                        }
                    }
                    .padding(.trailing, 5)
                }
            }
        }
        .background(Theme.bg2.ignoresSafeArea())
        .task { locate() }
    }

    /// 定位格 + 热门城市，4 列
    private var hotBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(t("city.locateHot")).font(.system(size: 12)).foregroundStyle(Theme.textSub)
                .padding(.top, 4)
            let cols = Array(repeating: GridItem(.flexible(), spacing: 8), count: 4)
            LazyVGrid(columns: cols, spacing: 8) {
                // 第一格是当前定位：定位到了点它直接选中；没定位到点它再试一次
                Button {
                    if let located { onSelect(located) } else if !locating { locate() }
                } label: {
                    chip(locating ? t("city.locating") : (located ?? t("city.locateUnavailable")), color: Theme.accent, bg: Theme.accent.opacity(0.12))
                }
                .buttonStyle(.plain)
                ForEach(hotCities, id: \.self) { name in
                    Button { onSelect(name) } label: {
                        chip(name, color: name == current ? Theme.accent : Theme.text, bg: Theme.bg3)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func chip(_ text: String, color: Color, bg: Color) -> some View {
        Text(text).font(.system(size: 13)).foregroundStyle(color).lineLimit(1)
            .frame(maxWidth: .infinity).padding(.vertical, 9)
            .background(RoundedRectangle(cornerRadius: 10).fill(bg))
    }

    private func locate() {
        locating = true
        CityLocator.shared.detect { name in
            DispatchQueue.main.async {
                located = name
                locating = false
            }
        }
    }
}

/// 动态卡片
struct MomentCardView: View {
    let m: Moment
    /// 详情页内嵌时关闭跳转链接，避免无限嵌套
    var enableDetailLink: Bool = true
    /// 详情页有独立播放器时隐藏卡片内视频封面，避免重复
    var showVideoCover: Bool = true
    /// 观看者位置（用于距离显示）
    var viewerLocation: CLLocation? = nil
    /// 点视频封面：传了就交给调用方处理，不传则原地播放（广场现在不传，抖音模式已下线）
    var onOpenVideo: (() -> Void)? = nil
    var onVideoCall: (MomentUser) -> Void
    @EnvironmentObject private var appState: AppState
    @State private var liked = false
    @State private var likeCount = 0
    @State private var following = false
    @State private var inited = false
    @State private var fullImage: String?
    @State private var playingVideo = false
    @State private var videoPlayer: AVPlayer?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                // 点头像进入他人主页（自己的动态不跳转）
                if m.user?.id != appState.user?.id, let uid = m.user?.id, !uid.isEmpty {
                    RouteLink(.userHome(uid)) {
                        AvatarView(url: m.user?.avatar, size: 40)
                    }
                    .buttonStyle(.plain)
                } else {
                    AvatarView(url: m.user?.avatar, size: 40)
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        Text(m.user?.nickname ?? "").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.text)
                        // 位置紧跟昵称（迷你淡色标签）
                        if let cityName = m.cityName, !cityName.isEmpty {
                            Text(cityName).font(.system(size: 10)).foregroundStyle(Theme.textDim)
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(RoundedRectangle(cornerRadius: 3).fill(Color.black.opacity(0.05)))
                        }
                    }
                    Text(timeAgo(m.createdAt)).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                }
                Spacer()
                // 自己的动态不显示关注/视频通话按钮
                let isSelf = m.user?.id == appState.user?.id
                if !isSelf {
                    // 迷你按钮组：关注（实底）+ 视频通话（细描边）
                    Button {
                        Task {
                            if let r: FollowResp = try? await Api.request("/user/\(m.user?.id ?? "")/follow", method: "POST") {
                                following = r.following ?? !following
                            }
                        }
                    } label: {
                        Text(following ? t("common.followed") : t("common.follow"))
                            .font(.system(size: 12))
                            .foregroundStyle(following ? Theme.textSub : .white)
                            .padding(.horizontal, 11).padding(.vertical, 4)
                            .background {
                                if following {
                                    Capsule().stroke(Theme.line, lineWidth: 1)
                                } else {
                                    Capsule().fill(Theme.accent)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    // 视频按钮：对方打开了视频见面才显示；对方离线置灰不可点
                    if m.user?.allowVideo == true {
                        // 三态：通话中（占线）/ 离线置灰 / 可打
                        let peerOnline = m.user?.online == true
                        let peerBusy = m.user?.busy == true
                        let busyOrange = Color(red: 1, green: 0.67, blue: 0.24)
                        let fgColor: Color = peerBusy ? busyOrange : peerOnline ? Theme.accent : Theme.textDim
                        Button {
                            if peerBusy || !peerOnline { return }
                            if let u = m.user { onVideoCall(u) }
                        } label: {
                            Text(peerBusy ? t("plaza.inCall") : t("plaza.videoCall"))
                                .font(.system(size: 12))
                                .foregroundStyle(fgColor)
                                .padding(.horizontal, 11).padding(.vertical, 4)
                                .background(Capsule().stroke(fgColor.opacity(0.5), lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .disabled(peerBusy || !peerOnline)
                    }
                }
            }

            // 文字点击进详情；图片直接放大；视频点击原地播放
            Group {
                if enableDetailLink {
                    RouteLink(.moment(m.id)) { textBody }
                        .buttonStyle(.plain)
                } else {
                    textBody
                }
            }
            if m.type == 1, let imgs = m.images, !imgs.isEmpty {
                imageGrid(imgs)
            }
            if showVideoCover, m.type == 2, m.videoUrl?.isEmpty == false {
                videoBlock
            }

            // 操作行：左侧 在线状态 + 距离，右侧 点赞 / 评论
            HStack(spacing: 12) {
                if m.user?.online == true {
                    HStack(spacing: 4) {
                        Circle().fill(Theme.success).frame(width: 6, height: 6)
                        Text(t("plaza.online")).font(.system(size: 12)).foregroundStyle(Theme.success)
                    }
                } else {
                    HStack(spacing: 4) {
                        Circle().fill(Theme.textDim).frame(width: 6, height: 6)
                        Text(t("plaza.offline")).font(.system(size: 12)).foregroundStyle(Theme.textDim)
                    }
                }
                if let distance = distanceText {
                    HStack(spacing: 3) {
                        Image(systemName: "location.fill").font(.system(size: 9))
                        Text(distance).font(.system(size: 12))
                    }
                    .foregroundStyle(Theme.textSub)
                }
                Spacer()
                Button {
                    Task {
                        if let r: LikeResp = try? await Api.request("/moments/\(m.id)/like", method: "POST") {
                            let nl = r.liked ?? !liked
                            liked = nl; likeCount += nl ? 1 : -1
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: liked ? "heart.fill" : "heart").font(.system(size: 13))
                        Text(t("plaza.like") + (likeCount > 0 ? " \(likeCount)" : "")).font(.system(size: 13))
                    }
                    .foregroundStyle(liked ? Theme.accent : Theme.textSub)
                }
                .buttonStyle(.plain)
                .padding(.trailing, 8)

                Group {
                    let commentLabel = HStack(spacing: 4) {
                        Image(systemName: "bubble.right").font(.system(size: 12))
                        Text(t("plaza.comment") + ((m.commentCount ?? 0) > 0 ? " \(m.commentCount ?? 0)" : "")).font(.system(size: 13))
                    }
                    .foregroundStyle(Theme.textSub)

                    if enableDetailLink {
                        RouteLink(.moment(m.id)) { commentLabel }
                            .buttonStyle(.plain)
                    } else {
                        commentLabel
                    }
                }
            }
            .padding(.top, 12)

            Rectangle().fill(Theme.line).frame(height: 1).padding(.top, 14)
        }
        .padding(.horizontal, 16).padding(.top, 14)
        .onAppear {
            if !inited {
                liked = m.liked ?? false
                likeCount = m.likeCount ?? 0
                following = m.isFollowing ?? false
                inited = true
            }
        }
        .fullScreenCover(item: $fullImage) { img in
            let imgs = m.images ?? []
            ImageViewerView(images: imgs.isEmpty ? [img] : imgs, initial: max(0, imgs.firstIndex(of: img) ?? 0)) {
                fullImage = nil
            }
        }
    }

    /// 距离显示：优先作者实时上报位置，其次动态发布位置
    private var distanceText: String? {
        guard let my = viewerLocation else { return nil }
        let lat = m.user?.latitude ?? m.latitude
        let lng = m.user?.longitude ?? m.longitude
        guard let lat, let lng, lat != 0 || lng != 0 else { return nil }
        let meters = my.distance(from: CLLocation(latitude: lat, longitude: lng))
        if meters < 1000 { return "\(Int(meters))m" }
        return String(format: "%.1fkm", meters / 1000)
    }

    private var textBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let content = m.content, !content.isEmpty {
                Text(content).font(.system(size: 15)).foregroundStyle(Theme.text)
                    .lineSpacing(5).multilineTextAlignment(.leading)
                    .padding(.top, 10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 视频块：点击封面原地播放，不跳详情
    @ViewBuilder
    private var videoBlock: some View {
        Group {
            if playingVideo, let player = videoPlayer {
                VideoPlayer(player: player)
                    .frame(maxWidth: .infinity).frame(height: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .onDisappear { player.pause() }
            } else {
                ZStack {
                    if let cover = m.coverUrl, !cover.isEmpty {
                        RemoteImage(url: cover)
                            .frame(maxWidth: .infinity).frame(height: 200)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    } else {
                        RoundedRectangle(cornerRadius: 10).fill(Color.black)
                            .frame(maxWidth: .infinity).frame(height: 200)
                    }
                    Image(systemName: "play.fill").font(.system(size: 30)).foregroundStyle(.white)
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    if let onOpenVideo {
                        onOpenVideo()
                    } else if let v = m.videoUrl, let url = URL(string: Api.fullUrl(v)) {
                        let p = makeFastStartPlayer(url: url)
                        videoPlayer = p
                        playingVideo = true
                        // 互斥播放：开播前暂停其它正在播的视频
                        FeedVideoCenter.play(p)
                    }
                }
            }
        }
        // 说明文字与视频间距 8，无文字时与头部保持 10
        .padding(.top, m.content?.isEmpty == false ? 8 : 10)
    }

    @ViewBuilder
    private func imageGrid(_ imgs: [String]) -> some View {
        let cols = [GridItem(.flexible(), spacing: 4), GridItem(.flexible(), spacing: 4), GridItem(.flexible(), spacing: 4)]
        LazyVGrid(columns: cols, spacing: 4) {
            ForEach(imgs, id: \.self) { url in
                // 点图直接放大查看（进详情走文字/评论）
                RemoteImage(url: url)
                    .frame(height: 112)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                    .onTapGesture { fullImage = url }
            }
        }
        // 说明文字与图片间距 8，无文字时与头部保持 10
        .padding(.top, m.content?.isEmpty == false ? 8 : 10)
    }
}

/// 动态详情 + 评论
struct MomentDetailView: View {
    let momentId: String
    @State private var moment: Moment?
    @State private var comments: [CommentItem] = []
    @State private var input = ""
    @State private var showSticker = false
    @FocusState private var inputFocused: Bool
    @State private var chatTarget: ChatTarget?
    @State private var fullImage: String?
    @State private var detailPlayer: AVPlayer?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let m = moment {
                        // 详情页有独立播放器，卡片内不再显示视频封面（避免重复出一张图）
                        MomentCardView(m: m, enableDetailLink: false, showVideoCover: false, onVideoCall: { user in
                            startCallWithPermissions(calleeId: user.id, type: 2, name: user.nickname ?? "", avatar: user.avatar ?? "")
                        })
                        // 视频动态：详情页内直接播放（player 缓存在 State，避免重组时重建导致播放中断）
                        if m.type == 2, let v = m.videoUrl, !v.isEmpty {
                            VideoPlayer(player: detailPlayer)
                                .frame(height: 260)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                                .padding(.horizontal, 16).padding(.top, 4)
                                .onAppear {
                                    if detailPlayer == nil, let url = URL(string: Api.fullUrl(v)) {
                                        detailPlayer = makeFastStartPlayer(url: url)
                                    }
                                }
                                .onDisappear { detailPlayer?.pause() }
                        }
                    }
                    Text(t("userHome.comments") + " \(comments.count)")
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.text)
                        .padding(16)
                    ForEach(comments) { c in
                        HStack(alignment: .top, spacing: 10) {
                            AvatarView(url: c.user?.avatar, size: 34)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(c.user?.nickname ?? "").font(.system(size: 13)).foregroundStyle(Theme.textSub)
                                if let reply = c.replyToNickname, !reply.isEmpty {
                                    Text(t("moments.repliedTo", ["name": reply])).font(.system(size: 12)).foregroundStyle(Theme.textDim)
                                }
                                if let content = c.content, !content.isEmpty {
                                    Text(content).font(.system(size: 15)).foregroundStyle(Theme.text)
                                }
                                if let img = c.imageUrl, !img.isEmpty {
                                    RemoteImage(url: img)
                                        .frame(width: 120, height: 120)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                        .onTapGesture { fullImage = img }
                                }
                                Text(timeAgo(c.createdAt)).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 16).padding(.bottom, 14)
                    }
                }
            }

            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Button {
                        inputFocused = false; showSticker.toggle()
                    } label: {
                        Image(systemName: "face.smiling")
                            .font(.system(size: 18)).foregroundStyle(showSticker ? Theme.accent : Theme.textSub)
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(showSticker ? Theme.bubbleMine : Theme.bg3))
                    }
                    .buttonStyle(.plain)
                    TextField("", text: $input, prompt: Text(t("moments.saySomething")).foregroundColor(Theme.textSub))
                        .focused($inputFocused)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(Capsule().fill(Theme.bg3))
                        .foregroundStyle(Theme.text)
                    Button(t("common.send")) { send() }
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(canSend ? Theme.accent : Theme.textDim)
                        .disabled(!canSend)
                }
                .padding(12)
                if showSticker {
                    EmojiPanel(onEmoji: { input += $0 }, onDelete: { input = dropLastGrapheme(input) }, onKeyboard: { showSticker = false; inputFocused = true })
                }
            }
            .background(Theme.bg2)
            .onChange(of: inputFocused) { f in if f { showSticker = false } }
        }
        .fullBg()
        .navigationTitle(t("moments.detailTitle"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .fullScreenCover(item: $chatTarget) { t in
            ChatRoomSheet(target: t)
        }
        .fullScreenCover(item: $fullImage) { img in
            ImageViewerView(images: [img], initial: 0) { fullImage = nil }
        }
        .task { await load() }
    }

    private func load() async {
        moment = try? await Api.request("/moments/\(momentId)")
        comments = (try? await Api.request("/moments/\(momentId)/comments")) ?? []
    }

    private var canSend: Bool {
        !input.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespaces)
        guard canSend else { return }
        Task {
            let body: [String: Any] = ["content": text]
            let _: CommentItem? = try? await Api.request("/moments/\(momentId)/comments", method: "POST", body: body)
            input = ""
            showSticker = false
            await load()
        }
    }
}

/// 发布动态（图文 / 视频）
struct PublishView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var mode = "image"
    @State private var content = ""
    @State private var images: [String] = []
    @State private var videoUrl = ""
    @State private var coverUrl = ""
    @State private var videoThumb: UIImage?
    @State private var city = ""
    @State private var pubLocation: CLLocation?
    @State private var uploading = false
    @State private var uploadProgress: Double = 0
    @State private var publishing = false
    @State private var toastMsg: String?

    private var canPublish: Bool {
        !publishing && !uploading && (mode == "image" ? !images.isEmpty || !content.isEmpty : !videoUrl.isEmpty)
    }

    var body: some View {
        NavStack {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        HStack(spacing: 12) {
                            ForEach([("image", t("publish.modePhoto")), ("video", t("publish.modeVideo"))], id: \.0) { k, label in
                                Button {
                                    mode = k
                                } label: {
                                    Text(label)
                                        .font(.system(size: 14, weight: mode == k ? .bold : .regular))
                                        .foregroundStyle(mode == k ? .white : Theme.textSub)
                                        .padding(.horizontal, 18).padding(.vertical, 8)
                                        .background(Capsule().fill(mode == k ? AnyShapeStyle(Theme.accentGrad) : AnyShapeStyle(Theme.bg3)))
                                }
                                .buttonStyle(.plain)
                            }
                            Spacer()
                        }

                        if mode == "image" {
                            let cols = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
                            LazyVGrid(columns: cols, spacing: 8) {
                                ForEach(images, id: \.self) { url in
                                    ZStack(alignment: .topTrailing) {
                                        RemoteImage(url: url)
                                            .frame(height: 108)
                                            .clipShape(RoundedRectangle(cornerRadius: 10))
                                        Button {
                                            images.removeAll { $0 == url }
                                        } label: {
                                            Image(systemName: "xmark.circle.fill")
                                                .foregroundStyle(.white, .black.opacity(0.6))
                                                .padding(4)
                                        }
                                    }
                                }
                                if images.count < 9 {
                                    CompatPhotoPicker(kind: .images, maxCount: 9 - images.count, onPicked: { datas in
                                        Task {
                                            uploading = true
                                            let total = datas.count
                                            for (idx, data) in datas.enumerated() {
                                                if let url = try? await Api.upload("image", data: data, filename: "img.jpg", mime: "image/jpeg", progress: { p in
                                                    uploadProgress = (Double(idx) + p) / Double(total)
                                                }) {
                                                    images.append(url)
                                                }
                                            }
                                            uploading = false
                                            uploadProgress = 0
                                        }
                                    }) {
                                        VStack {
                                            Text(uploading ? t("channel.uploading") : "+")
                                                .font(uploading ? .system(size: 12) : .system(size: 30, weight: .light))
                                                .foregroundStyle(Theme.textSub)
                                        }
                                        .frame(maxWidth: .infinity).frame(height: 108)
                                        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg2))
                                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line, style: StrokeStyle(lineWidth: 1, dash: [5])))
                                    }
                                }
                            }
                        } else {
                            if videoUrl.isEmpty {
                                CompatPhotoPicker(kind: .videos, onPickedFiles: { urls in
                                    guard let picked = urls.first else { return }
                                    Task {
                                        uploading = true
                                        uploadProgress = 0
                                        do {
                                            let data = try Data(contentsOf: picked)
                                            videoUrl = try await Api.upload("video", data: data, filename: "video.mp4", mime: "video/mp4", progress: { p in
                                                uploadProgress = p
                                            })
                                            // 生成首帧：本地预览 + 上传作为封面
                                            let gen = AVAssetImageGenerator(asset: AVURLAsset(url: picked))
                                            gen.appliesPreferredTrackTransform = true
                                            if let cg = try? gen.copyCGImage(at: .zero, actualTime: nil) {
                                                let thumb = UIImage(cgImage: cg)
                                                videoThumb = thumb
                                                if let jpeg = thumb.jpegData(compressionQuality: 0.8),
                                                   let cover = try? await Api.upload("image", data: jpeg, filename: "cover.jpg", mime: "image/jpeg") {
                                                    coverUrl = cover
                                                }
                                            }
                                        } catch {
                                            toastMsg = t("publish.videoUploadFailed", ["err": error.localizedDescription])
                                        }
                                        uploading = false
                                        uploadProgress = 0
                                    }
                                }) {
                                    VStack(spacing: 8) {
                                        Text(uploading ? t("channel.uploading") : t("publish.chooseVideo"))
                                            .font(.system(size: 14)).foregroundStyle(Theme.textSub)
                                    }
                                    .frame(maxWidth: .infinity).frame(height: 180)
                                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
                                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, style: StrokeStyle(lineWidth: 1, dash: [5])))
                                }
                            } else {
                                ZStack(alignment: .topTrailing) {
                                    ZStack {
                                        if let thumb = videoThumb {
                                            Image(uiImage: thumb).resizable().scaledToFill()
                                        } else { Theme.bg3 }
                                        Image(systemName: "play.fill").font(.system(size: 30)).foregroundStyle(.white)
                                    }
                                    .frame(maxWidth: .infinity).frame(height: 200)
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                                    Button {
                                        videoUrl = ""; videoThumb = nil
                                    } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .foregroundStyle(.white, .black.opacity(0.6)).padding(6)
                                    }
                                }
                            }
                        }

                        VStack(alignment: .leading, spacing: 0) {
                            CompatVerticalTextField(text: $content, prompt: Text(t("publish.thoughtsPlaceholder")).foregroundColor(Theme.textSub), lineRange: 5 ... 10)
                                .foregroundStyle(Theme.text)
                                .padding(14)
                        }
                        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))

                        HStack {
                            Text(t("publish.cityLabel")).font(.system(size: 14)).foregroundStyle(Theme.textSub)
                            Spacer()
                            Button(city.isEmpty ? t("publish.locateGet") : city) {
                                CityLocator.shared.detectWithLocation { name, loc in
                                    DispatchQueue.main.async {
                                        if let name { city = name }
                                        pubLocation = loc ?? pubLocation
                                    }
                                }
                            }
                            .font(.system(size: 14)).foregroundStyle(Theme.text)
                        }
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
                    }
                    .padding(16)
                }

                if uploading {
                    VStack(spacing: 6) {
                        ProgressView(value: uploadProgress)
                            .tint(Theme.accent)
                        Text(t("publish.uploadingPct", ["n": Int(uploadProgress * 100)]))
                            .font(.system(size: 12)).foregroundStyle(Theme.textSub)
                    }
                    .padding(.horizontal, 16).padding(.bottom, 6)
                }
                AccentButton(title: publishing ? t("publish.posting") : t("publish.submit"), enabled: canPublish) { publish() }
                    .padding(.horizontal, 16).padding(.bottom, 10)
            }
            .fullBg()
            .navigationTitle(t("publish.post"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(t("common.cancel")) { dismiss() }.foregroundStyle(Theme.textSub)
                }
            }
            .toast($toastMsg)
        }
        .task {
            // 进入发布页自动定位（城市 + 经纬度，用于距离显示）
            CityLocator.shared.detectWithLocation { name, loc in
                DispatchQueue.main.async {
                    if city.isEmpty, let name { city = name }
                    pubLocation = loc ?? pubLocation
                }
            }
        }
    }

    private func publish() {
        publishing = true
        Task {
            var body: [String: Any] = [
                "type": mode == "video" ? 2 : 1,
                "content": content.trimmingCharacters(in: .whitespaces),
                "images": images,
            ]
            if mode == "video" {
                body["videoUrl"] = videoUrl
                if !coverUrl.isEmpty { body["coverUrl"] = coverUrl }
            }
            if !city.isEmpty { body["cityName"] = city }
            if let loc = pubLocation {
                body["latitude"] = loc.coordinate.latitude
                body["longitude"] = loc.coordinate.longitude
            }
            do {
                // 创建接口返回的是数据库原始记录（images 为 JSON 字符串），宽容解析避免误报
                struct CreatedResp: Codable {}
                let _: CreatedResp = try await Api.request("/moments", method: "POST", body: body)
                dismiss()
            } catch {
                toastMsg = error.localizedDescription
            }
            publishing = false
        }
    }
}

/// 我的动态（双列网格，对齐 Android/Web）
struct MyMomentsView: View {
    @State private var items: [Moment] = []
    @State private var deleting: Moment?

    var body: some View {
        Group {
            if items.isEmpty {
                EmptyHint(text: t("profile.myMomentsEmpty"))
            } else {
                ScrollView {
                    let cols = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
                    LazyVGrid(columns: cols, spacing: 8) {
                        ForEach(items) { m in
                            momentCell(m)
                        }
                    }
                    .padding(12)
                }
            }
        }
        .fullBg()
        .navigationTitle(t("me.myMoments"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .confirmationDialog(t("moments.deleteConfirm"), isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button(t("common.delete"), role: .destructive) {
                guard let m = deleting else { return }
                Task {
                    struct OkResp: Codable { var ok: Bool? }
                    if let _: OkResp = try? await Api.request("/moments/\(m.id)", method: "DELETE") {
                        items.removeAll { $0.id == m.id }
                    }
                    deleting = nil
                }
            }
            Button(t("common.cancel"), role: .cancel) { deleting = nil }
        }
        .task {
            items = (try? await Api.request("/moments/mine")) ?? []
        }
    }

    private func momentCell(_ m: Moment) -> some View {
        let cover = m.type == 2 ? (m.coverUrl ?? "") : (m.images?.first ?? "")
        return ZStack(alignment: .topTrailing) {
            RouteLink(.moment(m.id)) {
                VStack(alignment: .leading, spacing: 0) {
                    if !cover.isEmpty {
                        RemoteImage(url: cover)
                            .frame(maxWidth: .infinity).frame(height: 150)
                            .clipped()
                    } else {
                        Text(m.content ?? "")
                            .font(.system(size: 14)).foregroundStyle(Theme.text)
                            .lineLimit(4).multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, minHeight: 110, alignment: .topLeading)
                            .padding(14)
                            .background(Theme.bg3)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        if !cover.isEmpty, let content = m.content, !content.isEmpty {
                            Text(content).font(.system(size: 13)).foregroundStyle(Theme.text).lineLimit(2)
                                .multilineTextAlignment(.leading)
                        }
                        Text(t("moments.stats", ["likes": m.likeCount ?? 0, "comments": m.commentCount ?? 0]))
                            .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                }
                .background(Theme.bg2)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)

            Button { deleting = m } label: {
                Text("×").font(.system(size: 16)).foregroundStyle(.white)
                    .frame(width: 26, height: 26)
                    .background(Circle().fill(Color.black.opacity(0.55)))
            }
            .buttonStyle(.plain)
            .padding(6)
        }
    }
}
