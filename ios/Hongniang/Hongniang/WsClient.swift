import Foundation

struct MessagePayload: Codable {
    let id: String
    let conversationId: String
    let convType: Int
    let groupId: String?
    let senderId: String
    let senderNickname: String
    let senderAvatar: String
    let receiverId: String?
    let type: String
    let content: String
    let createdAt: String
    var replyTo: ReplyPreview?
    var fwdFrom: String?
    var reactions: [MsgReaction]?
}

struct ReplyPreview: Codable, Equatable {
    var id: String
    var senderId: String? = nil
    var senderNickname: String? = nil
    var type: String? = nil
    var content: String? = nil
    var deleted: Bool? = nil
}

struct MsgReaction: Codable, Equatable {
    var emoji: String
    var count: Int
    var userIds: [String]
}

/// IM WebSocket：自动重连 + 心跳 + 帧分发（协议见后端 im.types.ts）
final class WsClient: NSObject {
    static let shared = WsClient()

    private var task: URLSessionWebSocketTask?
    private var manualClose = false
    private var listeners: [UUID: ([String: Any]) -> Void] = [:]
    private var heartbeatTimer: Timer?
    /// 连接断过（或者没连上）：下一次连上、收到第一帧时，给各页面发一个 { op: "ws_reopen" }（不是服务器的帧），
    /// 页面收到就补拉一次——断线那段时间的消息和群的变化没收到。数据平时都靠推送，不轮询。
    private var dropped = false

    func connect() {
        guard let token = Api.token else { return }
        // 已有存活连接则跳过；僵死连接（后台被挂起）直接重建
        if let task, task.state == .running { return }
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        manualClose = false
        let wsBase = Api.baseURL.replacingOccurrences(of: "http", with: "ws")
        guard let url = URL(string: "\(wsBase)/ws?token=\(token)&lang=\(I18nStore.shared.lang)") else { return }
        task = URLSession.shared.webSocketTask(with: url)
        task?.resume()
        receiveLoop()
        // 断过以后重连：马上问一声，服务器回了 pong 就知道连上了（见 receiveLoop 里的 ws_reopen）
        if dropped { sendFrame(["op": "ping"]) }

        DispatchQueue.main.async { [weak self] in
            self?.heartbeatTimer?.invalidate()
            self?.heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { _ in
                self?.sendFrame(["op": "ping"])
            }
        }
    }

    func close() {
        manualClose = true
        dropped = false
        heartbeatTimer?.invalidate()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    @discardableResult
    func addListener(_ handler: @escaping ([String: Any]) -> Void) -> () -> Void {
        let id = UUID()
        listeners[id] = handler
        return { [weak self] in self?.listeners.removeValue(forKey: id) }
    }

    /// 发送消息，返回 tempId
    @discardableResult
    func send(convType: Int, targetId: String, msgType: String, content: String, replyToId: String? = nil) -> String {
        let tempId = "t_\(Int(Date().timeIntervalSince1970 * 1000))_\(Int.random(in: 1000...9999))"
        var frame: [String: Any] = [
            "op": "send",
            "tempId": tempId,
            "convType": convType,
            "targetId": targetId,
            "msgType": msgType,
            "content": content,
        ]
        if let replyToId { frame["replyToId"] = replyToId }
        sendFrame(frame)
        return tempId
    }

    func markRead(conversationId: String, msgId: String) {
        sendFrame(["op": "read", "conversationId": conversationId, "msgId": msgId])
    }

    private func sendFrame(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                // 断过以后收到的第一帧：连上了，让各页面补拉一次
                if self.dropped {
                    self.dropped = false
                    DispatchQueue.main.async {
                        self.listeners.values.forEach { $0(["op": "ws_reopen"]) }
                    }
                }
                if case .string(let text) = message,
                   let data = text.data(using: .utf8),
                   let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    DispatchQueue.main.async {
                        self.listeners.values.forEach { $0(frame) }
                    }
                }
                self.receiveLoop()
            case .failure:
                self.task = nil
                if !self.manualClose {
                    self.dropped = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.connect() }
                }
            }
        }
    }
}
