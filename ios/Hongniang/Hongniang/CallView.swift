import AVFoundation
import SwiftUI
import WebRTC

/// 通话全屏界面（微信式），由 CallWindow 独立窗口承载
struct CallOverlay: View {
    @ObservedObject private var manager = CallManager.shared

    var body: some View {
        ZStack {
            if manager.phase != .idle {
                content
            } else if let pending = manager.pendingRate {
                // 视频通话结束后男方评分界面
                CallRateView(pending: pending)
            }
            // 独立提示弹框（积分不足等）：盖在最上层，点「知道了」关闭
            if let alert = manager.alertMsg {
                ZStack {
                    Color.black.opacity(0.55).ignoresSafeArea()
                    VStack(spacing: 16) {
                        Text(t("common.tip"))
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Theme.text)
                        Text(alert)
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.textSub)
                            .multilineTextAlignment(.center)
                            .lineSpacing(5)
                        Button {
                            manager.alertMsg = nil
                        } label: {
                            Text(t("common.gotIt"))
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(Capsule().fill(Theme.accentGrad))
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 4)
                    }
                    .padding(22)
                    .frame(width: 280)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Theme.bg2))
                }
            }
        }
        // 视频按分钟收牵豆（只有男方付，样稿 design/10-qiandou.html）：这两个框和通话界面在同一个独立窗口里，能盖住任何页面
        .overlay {
            // ① 我要付牵豆的视频：拨出去之前先看价格，点「开始视频」才拨。点暗处 = 取消
            if let ask = manager.feeAsk {
                ZStack(alignment: .bottom) {
                    Color.black.opacity(0.45).ignoresSafeArea().onTapGesture { manager.feeAsk = nil }
                    feeAskCard(ask)
                }
            }
        }
        .overlay {
            // ② 牵豆不够（发起时 / 接听时 / 通话中用完被服务器挂断）：说清楚，可以去充值
            if let nb = manager.noBeans {
                ZStack {
                    Color.black.opacity(0.55).ignoresSafeArea()
                    VStack(spacing: 0) {
                        Text(nb.title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text).multilineTextAlignment(.center)
                        Text(nb.text).font(.system(size: 14)).foregroundStyle(Theme.textSub).multilineTextAlignment(.center).lineSpacing(5)
                            .padding(.top, 8)
                        HStack(spacing: 10) {
                            Button { manager.noBeans = nil } label: { feeButton("知道了", primary: false) }.buttonStyle(.plain)
                            Button { manager.noBeans = nil; presentTopup() } label: { feeButton("去充值", primary: true) }.buttonStyle(.plain)
                        }
                        .padding(.top, 18)
                    }
                    .padding(22)
                    .frame(width: 290)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Theme.bg2))
                }
            }
        }
        .overlay(alignment: .top) {
            if let msg = manager.errorMsg {
                Text(msg)
                    .font(.system(size: 14)).foregroundStyle(.white)
                    .padding(.horizontal, 18).padding(.vertical, 10)
                    .background(Capsule().fill(Color.black.opacity(0.85)))
                    .padding(.top, 60)
                    .onAppear {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                            manager.errorMsg = nil
                        }
                    }
            }
        }
    }

    // MARK: - 视频收牵豆

    /// 来电：这通视频要我付牵豆（女方打给男方）时的收费信息；不用我付 / 不收费是 nil
    private var payFee: CallFee? {
        guard let f = manager.incomingFee, f.iPay == true, f.free != true else { return nil }
        return f
    }

    /// 来电：我的牵豆够不够接这一通
    private var payEnough: Bool { payFee?.enough ?? true }

    /// 发起前的价格确认：从底下升上来的一张卡
    private func feeAskCard(_ ask: CallManager.FeeAsk) -> some View {
        let fee = ask.fee
        let enough = fee.enough ?? true
        let perMin = fee.perMin ?? ""
        let balance = fee.balance ?? ""
        return VStack(alignment: .leading, spacing: 0) {
            Text(ask.name.isEmpty ? "视频见面" : "和\(ask.name)视频见面")
                .font(.system(size: 18, weight: .heavy)).foregroundStyle(Theme.text)
            feeRow("价格", "\(perMin) 牵豆 / 分钟").padding(.top, 10)
            Rectangle().fill(Theme.line).frame(height: 0.5)
            feeRow("谁付", "由你支付，对方不花钱")
            Rectangle().fill(Theme.line).frame(height: 0.5)
            feeRow("你的牵豆", enough ? "\(balance)，大约能聊 \(fee.minutes ?? 0) 分钟" : "\(balance)，不够 1 分钟")
            Text(enough ? "接通后开始算，不满 1 分钟按 1 分钟。牵豆用完会自动挂断。" : "牵豆不够，至少要 \(perMin)。充值后再打。")
                .font(.system(size: 12)).foregroundStyle(enough ? Theme.textSub : Theme.accent).lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8)
            HStack(spacing: 10) {
                Button { manager.feeAsk = nil } label: { feeButton("取消", primary: false) }.buttonStyle(.plain)
                Button {
                    manager.feeAsk = nil
                    if enough {
                        manager.startCall(calleeId: ask.calleeId, type: 2, name: ask.name, avatar: ask.avatar, feeConfirmed: true)
                    } else {
                        presentTopup()
                    }
                } label: { feeButton(enough ? "开始视频" : "去充值", primary: true) }.buttonStyle(.plain)
            }
            .padding(.top, 16)
        }
        .padding(.horizontal, 20).padding(.top, 22).padding(.bottom, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 28).fill(Theme.bg2).ignoresSafeArea(edges: .bottom))
    }

    private func feeRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).font(.system(size: 14)).foregroundStyle(Theme.textSub)
            Spacer(minLength: 12)
            Text(value).font(.system(size: 14, weight: .bold)).foregroundStyle(Theme.text).multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 9)
    }

    private func feeButton(_ title: String, primary: Bool) -> some View {
        Text(title)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(primary ? Color.white : Theme.textSub)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .background(Capsule().fill(primary ? AnyShapeStyle(Theme.accentGrad) : AnyShapeStyle(Color.gray.opacity(0.16))))
    }

    @ViewBuilder
    private var content: some View {
        ZStack {
            Color(red: 0.09, green: 0.10, blue: 0.12).ignoresSafeArea()

            switch manager.phase {
            case .idle:
                EmptyView()
            case let .outgoing(_, _, type):
                VStack {
                    Spacer().frame(height: 110)
                    peerHeader(status: type == 2 ? t("call.waitingVideo") : t("call.waitingVoice"))
                    Spacer()
                    HStack {
                        Spacer()
                        circleButton(icon: "phone.down.fill", label: t("common.cancel"), bg: Color(red: 0.98, green: 0.27, blue: 0.27)) {
                            manager.hangup()
                        }
                        Spacer()
                    }
                    .padding(.bottom, 70)
                }
            case let .incoming(_, _, _, type):
                VStack {
                    Spacer().frame(height: 110)
                    peerHeader(status: type == 2 ? t("call.invitedVideo") : t("call.invitedVoice"))
                    // 这通视频要我付牵豆（女方打给男方）：接听之前把价格写出来，点「接听」才开始算。牵豆不够时「接听」换成「去充值」
                    if let fee = payFee {
                        Text(payEnough
                             ? "接听后由你支付 \(fee.perMin ?? "") 牵豆 / 分钟\n你现在有 \(fee.balance ?? "") 牵豆"
                             : "牵豆不够，充值后才能接听\n视频见面 \(fee.perMin ?? "") 牵豆 / 分钟，你现在有 \(fee.balance ?? "")")
                            .font(.system(size: 13)).foregroundStyle(.white).multilineTextAlignment(.center).lineSpacing(4)
                            .padding(.horizontal, 16).padding(.vertical, 9)
                            .background(RoundedRectangle(cornerRadius: 18).fill(Color.white.opacity(0.14)))
                            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.28), lineWidth: 1))
                            .padding(.top, 18)
                    }
                    Spacer()
                    HStack {
                        Spacer()
                        circleButton(icon: "phone.down.fill", label: t("call.decline"), bg: Color(red: 0.98, green: 0.27, blue: 0.27)) {
                            manager.reject()
                        }
                        Spacer()
                        if payFee != nil && !payEnough {
                            circleButton(icon: "plus", label: "去充值", bg: Theme.accent) {
                                manager.rejectForTopup()
                            }
                        } else {
                            circleButton(icon: "phone.fill", label: t("call.answer"), bg: Color(red: 0.05, green: 0.78, blue: 0.42)) {
                                requestPermissions(video: type == 2) { manager.accept() }
                            }
                        }
                        Spacer()
                    }
                    .padding(.bottom, 70)
                }
            case let .active(_, _, type):
                if type == 2 {
                    videoActive
                } else {
                    voiceActive
                }
            }
        }
    }

    // MARK: - 通话中

    private var voiceActive: some View {
        VStack {
            Spacer().frame(height: 110)
            peerHeader(status: timeText)
            Spacer()
            HStack {
                Spacer()
                circleButton(icon: manager.muted ? "mic.slash.fill" : "mic.fill", label: t("call.mute"),
                             bg: manager.muted ? .white : Color.white.opacity(0.2),
                             fg: manager.muted ? .black : .white) {
                    manager.toggleMute()
                }
                Spacer()
                circleButton(icon: "phone.down.fill", label: t("call.hangUp"), bg: Color(red: 0.98, green: 0.27, blue: 0.27)) {
                    manager.hangup()
                }
                Spacer()
                circleButton(icon: manager.speakerOn ? "speaker.wave.3.fill" : "speaker.fill", label: t("call.speaker"),
                             bg: manager.speakerOn ? .white : Color.white.opacity(0.2),
                             fg: manager.speakerOn ? .black : .white) {
                    manager.toggleSpeaker()
                }
                Spacer()
            }
            .padding(.bottom, 70)
        }
    }

    /// 小窗交互状态：拖动移动 / 双击与大画面互换 / 「—」缩成小圆点、点小圆点还原
    @State private var swapped = false
    @State private var minimized = false
    @State private var smallPos: CGPoint?          // 小窗左上角（容器坐标），nil = 默认右上
    @State private var dragOffset: CGSize = .zero

    private var videoActive: some View {
        GeometryReader { geo in
            let winSize = minimized ? CGSize(width: 48, height: 48) : CGSize(width: 110, height: 150)
            let margin: CGFloat = 12, topMin: CGFloat = 96, bottomMin: CGFloat = 170
            let clamp: (CGPoint) -> CGPoint = { p in
                CGPoint(
                    x: min(max(p.x, margin), max(margin, geo.size.width - winSize.width - margin)),
                    y: min(max(p.y, topMin), max(topMin, geo.size.height - winSize.height - bottomMin))
                )
            }
            let base = clamp(smallPos ?? CGPoint(x: geo.size.width - 110 - margin, y: topMin + 4))
            let shown = clamp(CGPoint(x: base.x + dragOffset.width, y: base.y + dragOffset.height))

            ZStack(alignment: .topLeading) {
                RTCVideoViewRepresentable(track: swapped ? manager.localVideoTrack : manager.remoteVideoTrack, label: swapped ? "local(big)" : "remote")
                    .ignoresSafeArea()

                VStack {
                    Text(timeText)
                        .font(.system(size: 14)).foregroundStyle(.white)
                        .padding(.horizontal, 12).padding(.vertical, 5)
                        .background(Capsule().fill(Color.black.opacity(0.4)))
                        .padding(.top, 60)
                    Spacer()
                    videoControls
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                // 视频按分钟扣牵豆（只有付的那一方有）：左上角写已用 / 还剩，每分钟变一次；只够这最后 1 分钟时出一条红的提醒
                if let f = manager.feeTick {
                    Text("已用 \(f.used) 牵豆\n还剩 \(f.balance)")
                        .font(.system(size: 12)).foregroundStyle(.white).lineSpacing(3)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Color.black.opacity(0.46)))
                        .padding(.leading, 12).padding(.top, 100)
                    if f.low {
                        Text("牵豆只够再聊 1 分钟了")
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 9)
                            .background(RoundedRectangle(cornerRadius: 16).fill(Color(red: 0.94, green: 0.27, blue: 0.22).opacity(0.92)))
                            .padding(.horizontal, 14).padding(.top, 262)
                    }
                }

                // 小窗
                Group {
                    if minimized {
                        Circle().fill(Color.black.opacity(0.55))
                            .overlay(Circle().stroke(Color.white.opacity(0.35), lineWidth: 1))
                            .overlay(Image(systemName: "video.fill").font(.system(size: 16)).foregroundStyle(.white))
                    } else {
                        RTCVideoViewRepresentable(track: swapped ? manager.remoteVideoTrack : manager.localVideoTrack, label: swapped ? "remote(small)" : "local")
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(alignment: .topTrailing) {
                                Button { minimized = true } label: {
                                    Rectangle().fill(.white).frame(width: 10, height: 2)
                                        .frame(width: 22, height: 22)
                                        .background(Circle().fill(Color.black.opacity(0.45)))
                                }
                                .buttonStyle(.plain)
                                .padding(5)
                            }
                            .overlay(alignment: .bottom) {
                                Text(t("call.doubleTapSwap")).font(.system(size: 9)).foregroundStyle(.white.opacity(0.7))
                                    .padding(.horizontal, 5).padding(.vertical, 1)
                                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.35)))
                                    .padding(.bottom, 5)
                            }
                    }
                }
                .frame(width: winSize.width, height: winSize.height)
                .contentShape(Rectangle())
                .offset(x: shown.x, y: shown.y)
                .onTapGesture(count: 2) { if !minimized { swapped.toggle() } }
                .onTapGesture { if minimized { minimized = false } }
                .simultaneousGesture(
                    DragGesture(minimumDistance: 4)
                        .onChanged { dragOffset = $0.translation }
                        .onEnded { v in
                            smallPos = clamp(CGPoint(x: base.x + v.translation.width, y: base.y + v.translation.height))
                            dragOffset = .zero
                        }
                )
                .animation(.easeOut(duration: 0.15), value: minimized)
            }
        }
        // 每次进入视频通话都恢复默认布局（CallOverlay 常驻，状态不会自动重置）
        .onAppear { swapped = false; minimized = false; smallPos = nil; dragOffset = .zero }
    }

    /// 视频通话底部按钮行
    private var videoControls: some View {
        HStack {
            Spacer()
            circleButton(icon: manager.muted ? "mic.slash.fill" : "mic.fill", label: t("call.mute"),
                         bg: manager.muted ? .white : Color.white.opacity(0.25),
                         fg: manager.muted ? .black : .white) {
                manager.toggleMute()
            }
            Spacer()
            circleButton(icon: manager.cameraOff ? "video.slash.fill" : "video.fill", label: t("call.camera"),
                         bg: manager.cameraOff ? .white : Color.white.opacity(0.25),
                         fg: manager.cameraOff ? .black : .white) {
                manager.toggleCameraOff()
            }
            Spacer()
            circleButton(icon: "phone.down.fill", label: t("call.hangUp"), bg: Color(red: 0.98, green: 0.27, blue: 0.27)) {
                manager.hangup()
            }
            Spacer()
            circleButton(icon: "arrow.triangle.2.circlepath.camera.fill", label: t("call.flip"),
                         bg: Color.white.opacity(0.25)) {
                manager.switchCamera()
            }
            Spacer()
        }
        .padding(.bottom, 70)
    }

    // MARK: - 组件

    private var timeText: String {
        String(format: "%02d:%02d", manager.callSeconds / 60, manager.callSeconds % 60)
    }

    private func peerHeader(status: String) -> some View {
        VStack(spacing: 14) {
            AvatarView(url: manager.peerAvatar, size: 96)
            Text(manager.peerName.isEmpty ? t("call.peer") : manager.peerName)
                .font(.system(size: 22, weight: .semibold)).foregroundStyle(.white)
            Text(status)
                .font(.system(size: 14)).foregroundStyle(.white.opacity(0.6))
        }
    }

    private func circleButton(icon: String, label: String, bg: Color, fg: Color = .white, action: @escaping () -> Void) -> some View {
        VStack(spacing: 8) {
            Button(action: action) {
                Image(systemName: icon)
                    .font(.system(size: 24))
                    .foregroundStyle(fg)
                    .frame(width: 64, height: 64)
                    .background(Circle().fill(bg))
            }
            .buttonStyle(.plain)
            Text(label).font(.system(size: 12)).foregroundStyle(.white.opacity(0.7))
        }
    }
}

/// 发起呼叫（含权限申请），type: 1=语音 2=视频
/// 打开充值牵豆的页面（网页 /ai-fee/topup）。从现在最上面的那个页面上再盖一层：
/// 来电页、牵豆不够的弹框都在通话的独立窗口里，聊天页又多半是全屏弹层，挂在根页面上的弹层会被挡住，所以直接用 UIKit 找最上面的页面来弹。
@MainActor
func presentTopup() {
    guard let scene = UIApplication.shared.connectedScenes
        .first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
        let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController
    else { return }
    var top = root
    while let presented = top.presentedViewController { top = presented }
    // 网页自己带顶栏和返回键；点返回会关掉这一层（HnWebPage 里的 dismiss）
    let page = NavStack { HnWebPage(route: "/ai-fee/topup") }
        .environmentObject(AppState.current ?? AppState())
    let host = UIHostingController(rootView: page)
    host.modalPresentationStyle = .fullScreen
    top.present(host, animated: true)
}

func startCallWithPermissions(calleeId: String, type: Int, name: String = "", avatar: String = "") {
    requestPermissions(video: type == 2) {
        // 权限回调在后台线程，显式切回主 actor 调用通话管理器
        Task { @MainActor in
            CallManager.shared.startCall(calleeId: calleeId, type: type, name: name, avatar: avatar)
        }
    }
}

private func requestPermissions(video: Bool, onGranted: @escaping () -> Void) {
    AVCaptureDevice.requestAccess(for: .audio) { audioOk in
        guard audioOk else {
            DispatchQueue.main.async { CallManager.shared.errorMsg = t("qr.micDenied") }
            return
        }
        if video {
            AVCaptureDevice.requestAccess(for: .video) { videoOk in
                guard videoOk else {
                    DispatchQueue.main.async { CallManager.shared.errorMsg = t("call.cameraDenied") }
                    return
                }
                DispatchQueue.main.async(execute: onGranted)
            }
        } else {
            DispatchQueue.main.async(execute: onGranted)
        }
    }
}

/// 视频通话结束后男方评分界面：5 个维度各 0-100 分，平均分为最终得分
struct CallRateView: View {
    let pending: CallManager.PendingRate
    @State private var scores: [Double] = Array(repeating: 80, count: 5)
    @State private var busy = false

    private var dims: [String] {
        [t("call.rate.real"), t("call.rate.coop"), t("call.rate.legs"), t("call.rate.curves"), t("call.rate.skin")]
    }

    var body: some View {
        ZStack {
            Color(red: 0.09, green: 0.10, blue: 0.12).ignoresSafeArea()
            VStack(spacing: 0) {
                Spacer().frame(height: 70)
                AvatarView(url: pending.peerAvatar, size: 72)
                Text(pending.peerName.isEmpty ? t("call.peer") : pending.peerName)
                    .font(.system(size: 18, weight: .semibold)).foregroundStyle(.white)
                    .padding(.top, 10)
                Text(t("call.rate.title"))
                    .font(.system(size: 13)).foregroundStyle(.white.opacity(0.6))
                    .padding(.top, 4)

                VStack(spacing: 14) {
                    ForEach(dims.indices, id: \.self) { i in
                        HStack(spacing: 10) {
                            Text(dims[i])
                                .font(.system(size: 14)).foregroundStyle(.white.opacity(0.85))
                                .frame(width: 92, alignment: .leading)
                            Slider(value: $scores[i], in: 0...100, step: 1)
                                .tint(Theme.accent)
                            Text("\(Int(scores[i]))")
                                .font(.system(size: 14, weight: .bold)).monospacedDigit()
                                .foregroundStyle(Theme.accent)
                                .frame(width: 34, alignment: .trailing)
                        }
                    }
                }
                .padding(.horizontal, 28).padding(.top, 26)

                Spacer()

                Button {
                    guard !busy else { return }
                    busy = true
                    Task {
                        struct RateOk: Codable { var ok: Bool?; var avg: Int? }
                        do {
                            let _: RateOk = try await Api.request("/call/rate", method: "POST", body: [
                                "callId": pending.callId,
                                "photo": Int(scores[0]),
                                "obedience": Int(scores[1]),
                                "legs": Int(scores[2]),
                                "chest": Int(scores[3]),
                                "skin": Int(scores[4]),
                            ])
                        } catch {}
                        CallManager.shared.pendingRate = nil
                        // 评分完成后留在女方个人主页
                        CallManager.shared.openUserHome = pending.peerId
                    }
                } label: {
                    Text(busy ? t("call.rate.submitting") : t("call.rate.submit"))
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 13)
                        .background(Capsule().fill(Theme.accent))
                }
                .padding(.horizontal, 28)

                Button {
                    CallManager.shared.pendingRate = nil
                    // 跳过评分同样留在女方个人主页
                    CallManager.shared.openUserHome = pending.peerId
                } label: {
                    Text(t("call.rate.skip"))
                        .font(.system(size: 14)).foregroundStyle(.white.opacity(0.5))
                        .padding(8)
                }
                .padding(.top, 8)
                Spacer().frame(height: 30)
            }
        }
    }
}

struct RTCVideoViewRepresentable: UIViewRepresentable {
    let track: RTCVideoTrack?
    var label: String = ""

    func makeCoordinator() -> Coordinator { Coordinator(label: label) }

    final class Coordinator: NSObject, RTCVideoViewDelegate {
        var boundTrack: RTCVideoTrack?
        private let label: String
        init(label: String) { self.label = label }

        // 首帧到达（或分辨率变化）时触发：确认解码帧真正送到了渲染器
        func videoView(_ videoView: RTCVideoRenderer, didChangeVideoSize size: CGSize) {
            CallManager.clog("renderer[\(label)] frame size=\(Int(size.width))x\(Int(size.height))")
        }
    }

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView()
        view.videoContentMode = .scaleAspectFill
        view.delegate = context.coordinator
        return view
    }

    func updateUIView(_ view: RTCMTLVideoView, context: Context) {
        // 轨道变化时重新绑定渲染器（先解绑旧轨道，避免重复/失效绑定）
        guard context.coordinator.boundTrack !== track else { return }
        context.coordinator.boundTrack?.remove(view)
        track?.add(view)
        context.coordinator.boundTrack = track
    }

    /// 小窗缩小 / 通话结束离开视图树时解绑轨道，避免渲染器一直挂在 track 上
    static func dismantleUIView(_ view: RTCMTLVideoView, coordinator: Coordinator) {
        coordinator.boundTrack?.remove(view)
        coordinator.boundTrack = nil
    }
}
