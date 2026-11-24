import SwiftUI
import AVFoundation
import CoreImage.CIFilterBuiltins

/// 从扫码结果里提取邀请名片码（名片二维码内容 https://域名/t/?u=短号）
func parseInviteCode(_ text: String) -> String? {
    guard text.contains("/t/"),
          let range = text.range(of: #"[?&]u=\d{1,19}"#, options: .regularExpression)
    else { return nil }
    return String(text[range].dropFirst(3))
}

/// 扫一扫（我的页 / 消息页搜索框共用）：相机扫到的内容交给 scanHandler
struct ScanFlowModifier: ViewModifier {
    @Binding var isPresented: Bool
    @State private var scanned: String?

    func body(content: Content) -> some View {
        content
            .fullScreenCover(isPresented: $isPresented) {
                QrScanView(hint: t("qr.scanPrompt")) { text in
                    // 等扫码页收起再处理，免得下一页的弹出 / push 被吞
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { scanned = text }
                }
            }
            .scanHandler($scanned)
    }
}

/// 扫到的二维码统一在这里处理（扫一扫、聊天图片「识别二维码」共用），text 置非 nil 即处理：
/// 邀请名片 → 私聊。
struct ScanHandlerModifier: ViewModifier {
    @Binding var text: String?
    @State private var chat: ChatTarget?
    @State private var toast: String?

    func body(content: Content) -> some View {
        content
            .toast($toast)
            .fullScreenCover(item: $chat) { t in
                ChatRoomSheet(target: t)
            }
            .onChange(of: text) { v in
                guard let t = v else { return }
                text = nil
                handle(t.trimmingCharacters(in: .whitespacesAndNewlines))
            }
    }

    private func handle(_ text: String) {
        if let code = parseInviteCode(text) {
            openByInvite(code)
        } else {
            toast = t("qr.unrecognized")
        }
    }

    private func openByInvite(_ code: String) {
        Task {
            struct Peer: Codable { var id: String; var nickname: String? }
            struct Resp: Codable { var conversationId: String; var peer: Peer }
            do {
                let r: Resp = try await Api.request("/im/conversations/open-by-code", method: "POST", body: ["code": code])
                chat = ChatTarget(convId: r.conversationId, convType: 1, targetId: r.peer.id, title: r.peer.nickname ?? "")
            } catch {
                toast = error.localizedDescription
            }
        }
    }
}

extension View {
    func scanFlow(isPresented: Binding<Bool>) -> some View { modifier(ScanFlowModifier(isPresented: isPresented)) }
    func scanHandler(_ text: Binding<String?>) -> some View { modifier(ScanHandlerModifier(text: text)) }
}

/// 生成二维码图片
func makeQRImage(_ text: String, size: CGFloat = 240) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage else { return nil }
    let scale = size / output.extent.width
    let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    guard let cg = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
    return UIImage(cgImage: cg)
}

/// 扫一扫
struct QrScanView: View {
    @Environment(\.dismiss) private var dismiss
    var hint: String? = nil
    let onResult: (String) -> Void
    @State private var denied = false

    var body: some View {
        ZStack {
            if denied {
                VStack(spacing: 12) {
                    Text(t("qr.noCameraPermission")).font(.system(size: 15)).foregroundStyle(Theme.text)
                    Text(t("qr.allowCameraHint")).font(.system(size: 12)).foregroundStyle(Theme.textDim)
                }
            } else {
                QrCameraView { text in
                    onResult(text)
                    dismiss()
                }
                .ignoresSafeArea()

                // 取景框
                RoundedRectangle(cornerRadius: 14)
                    .stroke(Theme.accent, lineWidth: 2)
                    .frame(width: 230, height: 230)
                Text(hint ?? t("qr.scanPrompt"))
                    .font(.system(size: 13)).foregroundStyle(.white)
                    .padding(.top, 300)
            }

            VStack {
                HStack {
                    Spacer()
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(Color.black.opacity(0.4)))
                    }
                    .padding(.trailing, 18)
                    .padding(.top, 8)
                }
                Spacer()
            }
        }
        .background(Color.black)
        .task {
            let status = AVCaptureDevice.authorizationStatus(for: .video)
            if status == .notDetermined {
                denied = !(await AVCaptureDevice.requestAccess(for: .video))
            } else {
                denied = status != .authorized
            }
        }
    }
}

/// 相机取景 + 二维码识别
private struct QrCameraView: UIViewControllerRepresentable {
    let onFound: (String) -> Void

    func makeUIViewController(context: Context) -> QrCameraController {
        let vc = QrCameraController()
        vc.onFound = onFound
        return vc
    }

    func updateUIViewController(_ vc: QrCameraController, context: Context) {}
}

final class QrCameraController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onFound: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var found = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.bounds
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)

        DispatchQueue.global(qos: .userInitiated).async { [session] in
            session.startRunning()
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        DispatchQueue.global(qos: .userInitiated).async { [session] in
            session.stopRunning()
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !found,
              let obj = objects.first as? AVMetadataMachineReadableCodeObject,
              let text = obj.stringValue else { return }
        found = true
        onFound?(text)
    }
}
