import Foundation

struct RatingInfo: Codable, Hashable {
    var avg: Int? = 0
    var count: Int? = 0
    /// 五维度均分（0-100），展示词：真实度/配合度/腿型/曲线/肤质
    var photo: Int? = 0
    var obedience: Int? = 0
    var legs: Int? = 0
    var chest: Int? = 0
    var skin: Int? = 0
}

/// 照片墙条目（user_album）
struct AlbumItem: Codable, Identifiable, Hashable {
    var id: String = "0"
    var type: Int? = 1
    var url: String = ""
    var coverUrl: String? = ""
    var sort: Int? = 0
}

/// 他人主页数据（/user/:id）
struct HomeProfile: Codable {
    var id: String = ""
    var nickname: String? = ""
    var avatar: String? = ""
    var gender: Int? = 0
    var age: Int? = 0
    var cityName: String? = ""
    var signature: String? = ""
    var isGuide: Bool? = false
    var following: Int? = 0
    var fans: Int? = 0
    var isFollowing: Bool? = false
    var rating: RatingInfo? = nil
    /// 视频接通率（%），-1=暂无数据，null=男生
    var answerRate: Int? = nil
    /// 对方打开了视频见面（默认关）
    var allowVideo: Bool? = false
    /// 相亲资料卡：对方完成资料收集后才有
    var matchProfile: MatchProfile? = nil
    var online: Bool? = false
    var busy: Bool? = false
    var realnameVerified: Bool? = false
    /// 照片墙（最多 8 张）
    var albums: [AlbumItem]? = []
}

struct ProjectItem: Codable, Identifiable, Hashable {
    var id: Int = 0
    var name: String = ""
    var desc: String? = ""
    var cover: String? = ""
    var type: String? = "native"
    var entry: String? = ""
}

/// 动态 / 评论的作者
struct MomentUser: Codable, Hashable {
    var id: String = ""
    var nickname: String? = ""
    var avatar: String? = ""
    var age: Int? = 0
    var online: Bool? = false
    var latitude: Double? = nil
    var longitude: Double? = nil
    /// 对方打开了视频见面（默认关）
    var allowVideo: Bool? = false
    /// 正在通话中（占线）
    var busy: Bool? = false
}

/// 广场动态：type 1=图文 2=视频
struct Moment: Codable, Identifiable, Hashable {
    var id: String = ""
    var user: MomentUser? = nil
    var content: String? = ""
    var type: Int? = 1
    var images: [String]? = []
    var videoUrl: String? = ""
    var coverUrl: String? = ""
    var cityName: String? = ""
    var latitude: Double? = nil
    var longitude: Double? = nil
    var likeCount: Int? = 0
    var commentCount: Int? = 0
    var liked: Bool? = false
    var isFollowing: Bool? = false
    var createdAt: String? = ""
}

struct CommentItem: Codable, Identifiable, Hashable {
    var id: String = ""
    var user: MomentUser? = nil
    var content: String? = ""
    var imageUrl: String? = ""
    var replyToNickname: String? = ""
    var createdAt: String? = ""
}

struct FollowResp: Codable { var following: Bool? = false }
struct LikeResp: Codable { var liked: Bool? = false }
struct OpenConvResp: Codable { var conversationId: String = "" }
struct UrlResp: Codable { var url: String = "" }
