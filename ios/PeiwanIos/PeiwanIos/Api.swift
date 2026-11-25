import Foundation
import Security

struct UserProfile: Codable {
    let id: String
    var shortId: String?
    var nickname: String
    var avatar: String
    let gender: Int
    var age: Int
    var cityCode: String
    var cityName: String
    var signature: String
    var isGuide: Bool
    /// 视频见面开关（默认关；双方都打开才能互相发起视频通话）
    var allowVideo: Bool?
    /// 是否已完成资料收集（只有 /user/me 返回）
    var profileDone: Bool?
    /// AI 深聊：none 没聊过 | chatting 聊到一半 | draft 画像等确认 | done 已确认（只有 /user/me 返回）
    var deepStatus: String?
    var realname: Bool?
    var realNameMasked: String?
    var following: Int?
    var fans: Int?
    /// 照片墙（最多 8 张）
    var albums: [AlbumItem]?
}

/// 注册归因到的邀请人（通过 TA 的专属邀请页下载安装）；仅异性时返回，客户端据此直接打开 TA 主页
struct InviterBrief: Codable {
    let id: String
    var nickname: String?
    var avatar: String?
    var gender: Int?
}

/// 通过刷脸新挂到这个账号上的一台设备（给其它设备的提醒里用）。kind：android | ios | web；label：网页的浏览器名
struct NewDevice: Codable, Equatable {
    var id: String
    var kind: String?
    var label: String?
    var at: String?

    /// 设备列表、提醒里怎么称呼它
    var name: String {
        switch kind ?? "" {
        case "android": return "安卓手机"
        case "ios": return "iPhone"
        default: return (label ?? "").isEmpty ? "网页" : "网页（\(label ?? "")）"
        }
    }
}

struct EnterResp: Codable {
    let registered: Bool
    let token: String?
    let user: UserProfile?
    var inviter: InviterBrief?
    /// 这台设备在服务器「登录设备」表里的编号（推送里靠它认出说的是不是本机）
    var did: String?
    /// 上次用这台设备之后，通过刷脸新挂到这个账号上的其它设备，提醒一次
    var newDevices: [NewDevice]?
}

struct AppModuleItem: Codable, Identifiable {
    let id: Int
    let name: String
    let icon: String
    let type: String
    let entry: String
}

struct ApiError: Error, LocalizedError {
    let code: Int
    let msg: String
    /// 服务端给的原因代码（例如 AI 费用的 no_balance / key_invalid），页面按它决定弹哪张提示
    var reason: String? = nil
    var errorDescription: String? { msg }
}


enum Api {
    // 测试环境（阿里云杭州），和安卓、网页连的是同一台。域名备案前只能用 IP + HTTP（Info.plist 里已经允许明文）；
    // 备案后换成 https://域名，正式包不能留这个地址。2026-11-23 之前这里还是心之音的正式服，新功能在那边没有。
    static let baseURL = "http://120.55.59.158"

    /// 我们自己的域名（含它的子域名）
    private static let ownDomain = "gphnai.com"

    /// 这个网址是不是我们自己的网页：http(s)，并且主机名和 `baseURL` 相同，或者是 `ownDomain` / 它的子域名。
    ///
    /// 大厅页、以及大厅页让 App 全屏打开的网页，只允许是自己的网页（这两处的地址都是服务器给的）：
    /// App 里能出现什么内容，要以送审的这一版为准，不能靠改服务器配置让 App 打开别人的网页；
    /// 另外大厅页的地址上带着登录令牌，不能发给别的网站。
    /// 以后要接别家的活动页，需要改这里、发新版本。
    static func isOwnWebUrl(_ url: URL?) -> Bool {
        // 用系统的 URLComponents 取主机名；不要自己切字符串，`http://gphnai.com@别的网站/` 这种写法会骗过去
        guard let url = url, let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = c.host?.lowercased(), !host.isEmpty else { return false }
        let own = URLComponents(string: baseURL)?.host?.lowercased()
        return host == own || host == ownDomain || host.hasSuffix("." + ownDomain)
    }

    // 一机一号：设备 ID 存 Keychain，卸载重装后仍在，凭此恢复账号
    static var deviceId: String {
        let account = "com.wh.hongniang.deviceid"
        if let data = keychainGet(account), let id = String(data: data, encoding: .utf8) {
            return id
        }
        let id = "ios_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        keychainSet(account, Data(id.utf8))
        return id
    }

    static var token: String? {
        get { UserDefaults.standard.string(forKey: "pw_token") }
        set { UserDefaults.standard.set(newValue, forKey: "pw_token") }
    }

    /// 这台设备在服务器「登录设备」表里的编号（进入 / 注册 / 刷脸找回 / 并号时服务器给的）
    static var did: String? {
        get { UserDefaults.standard.string(forKey: "pw_did") }
        set { UserDefaults.standard.set(newValue, forKey: "pw_did") }
    }

    private struct Envelope<T: Decodable>: Decodable {
        let code: Int
        let msg: String
        let data: T?
        let reason: String?
    }

    /// 注册头像上传（免登录），返回可访问的相对 URL
    static func uploadAvatar(_ imageData: Data) async throws -> String {
        struct UploadResp: Decodable { let url: String }
        var req = URLRequest(url: URL(string: baseURL + "/api/upload/avatar")!)
        req.httpMethod = "POST"
        let boundary = "Boundary-\(UUID().uuidString)"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"avatar.jpg\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(imageData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body
        let (data, _) = try await URLSession.shared.data(for: req)
        let envelope = try JSONDecoder().decode(Envelope<UploadResp>.self, from: data)
        guard envelope.code == 0, let value = envelope.data else {
            throw ApiError(code: envelope.code, msg: envelope.msg)
        }
        return value.url
    }

    /// 相对资源路径转完整 URL
    static func fullUrl(_ path: String) -> String {
        path.hasPrefix("http") || path.isEmpty ? path : baseURL + path
    }

    /// 登录后上传 kind=image|video|audio，progress 回调 0~1（主线程）
    static func upload(_ kind: String, data: Data, filename: String, mime: String, progress: ((Double) -> Void)? = nil) async throws -> String {
        struct R: Decodable { let url: String }
        var req = URLRequest(url: URL(string: baseURL + "/api/upload/\(kind)")!)
        req.httpMethod = "POST"
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.setValue(I18nStore.shared.lang, forHTTPHeaderField: "Accept-Language")
        let boundary = "B-\(UUID().uuidString)"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        // 用 task.progress KVO 跟踪上传进度（didSendBodyData 回调在部分系统版本不可靠）
        let d: Data = try await withCheckedThrowingContinuation { cont in
            var observation: NSKeyValueObservation?
            let task = URLSession.shared.uploadTask(with: req, from: body) { data, _, error in
                observation?.invalidate()
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume(returning: data ?? Data())
                }
            }
            observation = task.progress.observe(\.fractionCompleted) { p, _ in
                let value = p.fractionCompleted
                DispatchQueue.main.async { progress?(value) }
            }
            task.resume()
        }
        let env = try JSONDecoder().decode(Envelope<R>.self, from: d)
        guard env.code == 0, let v = env.data else { throw ApiError(code: env.code, msg: env.msg) }
        return v.url
    }

    /// 聊天文件上限，和后端 FILE_MAX_SIZE 一致：再大 Cloudflare 免费版直接回 413
    static let fileMaxSize = 100_000_000

    /// 聊天里发任意文件，progress 回调 0~1（主线程）
    static func uploadChatFile(_ fileURL: URL, name: String, mime: String, progress: ((Double) -> Void)? = nil) async throws -> ChatFileResp {
        let d = try await postFile("file", fileURL: fileURL, name: name, mime: mime, progress: progress)
        let env = try JSONDecoder().decode(Envelope<ChatFileResp>.self, from: d)
        guard env.code == 0, let v = env.data else { throw ApiError(code: env.code, msg: env.msg) }
        return v
    }

    /// 同 upload(kind=video|audio)，但从磁盘文件流式上传，返回相对 URL
    static func uploadFromFile(_ kind: String, fileURL: URL, name: String, mime: String, progress: ((Double) -> Void)? = nil) async throws -> String {
        struct R: Decodable { let url: String }
        let d = try await postFile(kind, fileURL: fileURL, name: name, mime: mime, progress: progress)
        let env = try JSONDecoder().decode(Envelope<R>.self, from: d)
        guard env.code == 0, let v = env.data else { throw ApiError(code: env.code, msg: env.msg) }
        return v.url
    }

    /// multipart 先流式写进临时文件再 uploadTask(fromFile:)，100MB 不进内存；返回响应体
    private static func postFile(_ path: String, fileURL: URL, name: String, mime: String, progress: ((Double) -> Void)?) async throws -> Data {
        var req = URLRequest(url: URL(string: baseURL + "/api/upload/\(path)")!)
        req.httpMethod = "POST"
        req.timeoutInterval = 300
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.setValue(I18nStore.shared.lang, forHTTPHeaderField: "Accept-Language")
        let boundary = "B-\(UUID().uuidString)"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let headerName = name.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
        let bodyURL = FileManager.default.temporaryDirectory.appendingPathComponent("up-\(UUID().uuidString).multipart")
        defer { try? FileManager.default.removeItem(at: bodyURL) }
        try writeMultipart(to: bodyURL, boundary: boundary, filename: headerName, mime: mime, source: fileURL)

        let (d, status): (Data, Int) = try await withCheckedThrowingContinuation { cont in
            var observation: NSKeyValueObservation?
            let task = URLSession.shared.uploadTask(with: req, fromFile: bodyURL) { data, resp, error in
                observation?.invalidate()
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume(returning: (data ?? Data(), (resp as? HTTPURLResponse)?.statusCode ?? 0))
                }
            }
            observation = task.progress.observe(\.fractionCompleted) { p, _ in
                let value = p.fractionCompleted
                DispatchQueue.main.async { progress?(value) }
            }
            task.resume()
        }
        // Cloudflare / nginx 拦下超大包体时回的是 HTML 413
        if status == 413 { throw ApiError(code: 413, msg: t("chat.file.tooLarge", ["name": name])) }
        return d
    }

    /// multipart 头 + 原文件（按 1MB 分块拷）+ 尾，写进 dest
    private static func writeMultipart(to dest: URL, boundary: String, filename: String, mime: String, source: URL) throws {
        FileManager.default.createFile(atPath: dest.path, contents: nil)
        let out = try FileHandle(forWritingTo: dest)
        defer { try? out.close() }
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        out.write(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8))
        var done = false
        while !done {
            // 每块用完就释放，不然 100MB 都攒到循环结束
            autoreleasepool {
                let chunk = input.readData(ofLength: 1 << 20)
                if chunk.isEmpty { done = true } else { out.write(chunk) }
            }
        }
        out.write(Data("\r\n--\(boundary)--\r\n".utf8))
    }

    static func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        var req = URLRequest(url: URL(string: baseURL + "/api" + path)!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        // 服务端按这个语言返回报错 / 配置项文字
        req.setValue(I18nStore.shared.lang, forHTTPHeaderField: "Accept-Language")
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, _) = try await URLSession.shared.data(for: req)
        let envelope = try JSONDecoder().decode(Envelope<T>.self, from: data)
        guard envelope.code == 0 else { throw ApiError(code: envelope.code, msg: envelope.msg, reason: envelope.reason) }
        guard let value = envelope.data else { throw ApiError(code: -1, msg: t("common.emptyData")) }
        return value
    }

    // MARK: - Keychain

    private static func keychainGet(_ account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    private static func keychainSet(_ account: String, _ data: Data) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var attrs = query
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attrs as CFDictionary, nil)
    }
}
