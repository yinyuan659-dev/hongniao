package com.wh.hongniang.net

import kotlinx.serialization.Serializable

@Serializable
data class RatingInfo(
    val avg: Int = 0,
    val count: Int = 0,
    /** 五维度均分（0-100），展示词：真实度/配合度/腿型/曲线/肤质 */
    val photo: Int = 0,
    val obedience: Int = 0,
    val legs: Int = 0,
    val chest: Int = 0,
    val skin: Int = 0,
)

/** 关注/粉丝列表条目（GET /user/follows/list） */
@Serializable
data class FollowUser(
    val id: String = "0",
    val nickname: String = "",
    val avatar: String = "",
    val age: Int = 0,
    val gender: Int = 1,
    val cityName: String = "",
    val signature: String = "",
)

/** 照片墙条目（user_album） */
@Serializable
data class AlbumItem(
    val id: String = "0",
    val type: Int = 1,
    val url: String = "",
    val coverUrl: String = "",
    val sort: Int = 0,
)

/** 他人主页数据（/user/:id） */
@Serializable
data class HomeProfile(
    val id: String,
    val nickname: String = "",
    val avatar: String = "",
    val gender: Int = 0,
    val age: Int = 0,
    val cityName: String = "",
    val signature: String = "",
    val following: Int = 0,
    val fans: Int = 0,
    val isFollowing: Boolean = false,
    val rating: RatingInfo? = null,
    /** 视频接通率（%），-1=暂无数据，null=男生 */
    val answerRate: Int? = null,
    /** 对方打开了视频见面（默认关） */
    val allowVideo: Boolean = false,
    /** 相亲资料卡：对方完成资料收集后才有 */
    val matchProfile: MatchProfile? = null,
    val online: Boolean = false,
    val busy: Boolean = false,
    val realnameVerified: Boolean = false,
    /** 照片墙（最多 8 张） */
    val albums: List<AlbumItem> = emptyList(),
)

@Serializable
data class MatchRow(val label: String = "", val value: String = "")

/** 相亲资料卡（AI 红娘收集的画像，给别人看的那部分，不含收入） */
@Serializable
data class MatchProfile(
    val summary: String = "",
    val tags: List<String> = emptyList(),
    val intro: String = "",
    val about: List<MatchRow> = emptyList(),
    val prefs: List<MatchRow> = emptyList(),
)

/** 遇见列表用户卡片（/user/meet/list） */
@Serializable
data class MeetUser(
    val id: String,
    val nickname: String = "",
    val avatar: String = "",
    val gender: Int = 0,
    val age: Int = 0,
    val cityName: String = "",
    val realnameVerified: Boolean = false,
    /** 0-100 平均分，显示时 /20 换算五星 */
    val ratingAvg: Int = 0,
    val ratingCount: Int = 0,
    /** 对方打开了视频见面（默认关） */
    val allowVideo: Boolean = false,
    val online: Boolean = false,
    val busy: Boolean = false,
    /** 注册 7 天内 */
    val isNew: Boolean = false,
    /** 与我的亲密度分（0.5 粒度） */
    val intimacy: Double = 0.0,
    /** none 都没表态 | liked 我喜欢了 | likedMe 对方喜欢了我 | mutual 互相喜欢 */
    val like: String = "none",
)

/** 全局会话信息（登录后写入） */
object Session {
    var uid: String = ""
    var gender: Int = 0
    /** App 是否在前台（MainActivity 生命周期维护），后台来电用通知提醒 */
    @Volatile var foreground: Boolean = true
}

/** 动态 / 评论的作者 */
@Serializable
data class MomentUser(
    val id: String,
    val nickname: String = "",
    val avatar: String = "",
    val age: Int = 0,
    val online: Boolean = false,
    val latitude: Double? = null,
    val longitude: Double? = null,
    /** 对方打开了视频见面（默认关） */
    val allowVideo: Boolean = false,
    /** 正在通话中（占线） */
    val busy: Boolean = false,
)

/** 广场动态：type 1=图文 2=视频 */
@Serializable
data class Moment(
    val id: String,
    val user: MomentUser? = null,
    val content: String = "",
    val type: Int = 1,
    val images: List<String> = emptyList(),
    val videoUrl: String = "",
    val coverUrl: String = "",
    val cityName: String = "",
    val latitude: Double? = null,
    val longitude: Double? = null,
    val likeCount: Int = 0,
    val commentCount: Int = 0,
    val liked: Boolean = false,
    val isFollowing: Boolean = false,
    val createdAt: String = "",
)

@Serializable
data class CommentItem(
    val id: String,
    val user: MomentUser? = null,
    val content: String = "",
    val imageUrl: String = "",
    val replyToNickname: String = "",
    val createdAt: String = "",
)

@Serializable
data class CallConfigData(
    val width: Int = 640,
    val height: Int = 480,
    val fps: Int = 25,
    val bitrate: Int = 800,
    val srsServer: String = "",
    val whipUrl: String = "",
    val whepUrl: String = "",
)
