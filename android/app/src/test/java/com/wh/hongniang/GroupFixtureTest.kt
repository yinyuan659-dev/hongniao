package com.wh.hongniang

import com.wh.hongniang.net.Api
import com.wh.hongniang.net.ApiResp
import com.wh.hongniang.net.MessagePayload
import com.wh.hongniang.ui.screen.ConversationItem
import com.wh.hongniang.ui.screen.GroupEvent
import com.wh.hongniang.ui.screen.GroupInfo
import com.wh.hongniang.ui.screen.MsgItem
import com.wh.hongniang.ui.screen.PinItem
import com.wh.hongniang.ui.screen.SearchResp
import com.wh.hongniang.ui.screen.expireTip
import com.wh.hongniang.ui.screen.groupEndText
import com.wh.hongniang.ui.screen.groupEventOf
import com.wh.hongniang.ui.screen.groupPreview
import com.wh.hongniang.ui.screen.groupReasonState
import com.wh.hongniang.ui.screen.merged
import com.wh.hongniang.ui.screen.parseIso
import com.wh.hongniang.ui.screen.stateAfter
import com.wh.hongniang.ui.screen.sysText
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 群聊：服务器给的数据 App 认不认得。
 *
 * 样本 src/test/resources/group_fixture.json 是 deploy/group_app_fixture.py 用两个测试号在测试服务器上真的走了一遍
 * （建群、收发、改群名、免打扰、移出、解散）存下来的原样返回，这里用 App 自己的解析代码和状态计算去读它。
 * 界面本身（画得对不对、点了有没有反应）这里测不到，要在真机上看。
 * 接口改了以后：重新跑一次 group_app_fixture.py，再跑这个测试。
 */
class GroupFixtureTest {
    private val fx: JsonObject = Api.json.parseToJsonElement(
        javaClass.classLoader!!.getResourceAsStream("group_fixture.json")!!.readBytes().toString(Charsets.UTF_8),
    ).jsonObject

    private fun str(k: String) = fx[k]!!.jsonPrimitive.content
    private val gid get() = str("groupId")
    private val cid get() = str("conversationId")
    /** 普通成员（女测试号）、群主（男测试号） */
    private val memberId get() = str("memberId")
    private val ownerId get() = str("ownerId")
    private val memberName get() = str("memberName")
    private val ownerName get() = str("ownerName")

    private fun convs(k: String) = Api.json.decodeFromJsonElement(ListSerializer(ConversationItem.serializer()), fx[k]!!)
    private fun view(k: String) = Api.json.decodeFromJsonElement(GroupInfo.serializer(), fx[k]!!)
    private fun frame(k: String) = fx["frames"]!!.jsonObject[k]!!.jsonObject
    private fun event(k: String): GroupEvent = groupEventOf(frame(k)) ?: error("推送 $k 解析不出来")
    private fun payload(k: String) = Api.json.decodeFromJsonElement(MessagePayload.serializer(), frame(k)["data"]!!)

    /** 消息列表：群和单聊混在一个列表里，两种行都要认得 */
    @Test
    fun conversationListHasGroupAndSingleRows() {
        val rows = convs("convsMember")
        val row = rows.first { it.id == cid }
        assertEquals(2, row.type)
        assertNull(row.peer)
        val g = row.group!!
        assertEquals(gid, g.id)
        assertEquals("ok", g.state)
        assertEquals("member", g.role)
        assertEquals("test", g.kind)
        assertEquals(ownerId, g.ownerId)
        assertEquals(2, g.memberCount)
        assertTrue(g.name.startsWith("样本群"))
        assertFalse(row.muted)
        // 别人发的：「谁：说了什么」
        assertTrue(groupPreview(row.lastMsg, memberId), groupPreview(row.lastMsg, memberId).startsWith("$ownerName：样本：群主回复"))

        val mine = convs("convsOwner").first { it.id == cid }
        assertEquals("owner", mine.group!!.role)
        // 自己发的不加名字
        assertTrue(groupPreview(mine.lastMsg, ownerId), groupPreview(mine.lastMsg, ownerId).startsWith("样本：群主回复"))

        // 单聊那几行还是老样子：有 peer、没有 group
        (rows + convs("convsOwner")).filter { it.id != cid }.forEach {
            assertEquals(1, it.type)
            assertNotNull(it.peer)
            assertNull(it.group)
            assertFalse(it.muted)
        }
    }

    /** 开了免打扰的群：这一行带着 muted，未读照样有数（界面上只显示灰点、底部数字不算它） */
    @Test
    fun mutedGroupRow() {
        val row = convs("convsMemberMuted").first { it.id == cid }
        assertTrue(row.muted)
        assertTrue(row.unread > 0)
        assertTrue(row.group!!.name.startsWith("样本群改名"))
    }

    /** 已经用不了的群还留在列表里：状态要认对；预览是那行灰色小字，前面不加名字 */
    @Test
    fun goneGroupRows() {
        val kicked = convs("convsKicked").first { it.id == cid }
        assertEquals("kicked", kicked.group!!.state)
        assertEquals(0, kicked.unread)
        assertEquals("$memberName 被群主移出了群聊", groupPreview(kicked.lastMsg, memberId))

        val dissolved = convs("convsDissolved").first { it.id == cid }
        assertEquals("dissolved", dissolved.group!!.state)
        assertEquals(1, dissolved.group!!.status)
        assertEquals("群主解散了群聊", groupPreview(dissolved.lastMsg, ownerId))
    }

    /** 群资料：成员版、群主版、被移出以后、解散以后 */
    @Test
    fun groupInfo() {
        val m = view("viewMember")
        assertEquals("ok", m.state)
        assertEquals("member", m.role)
        assertFalse(m.muted)
        assertEquals(cid, m.conversationId)
        assertEquals(listOf(ownerId, memberId), m.members.map { it.id })
        assertEquals("owner", m.members[0].role)
        assertEquals(ownerName, m.members[0].nickname)
        assertTrue(m.members[0].avatar.isNotEmpty())

        assertEquals("owner", view("viewOwner").role)

        val changed = view("update")
        assertTrue(changed.name.startsWith("样本群改名"))
        assertEquals("早上 7 点集合\n带身份证", changed.notice)
        assertEquals(2, changed.members.size)

        val kicked = view("viewKicked")
        assertEquals("kicked", kicked.state)
        assertTrue(kicked.members.isEmpty())
        assertEquals("你已不在这个群里", groupEndText(kicked.state))

        val dissolved = view("viewDissolved")
        assertEquals("dissolved", dissolved.state)
        assertEquals("这个群已解散", groupEndText(dissolved.state))
    }

    /** 「N 天后自动解散」那句提示：没到结束时间不提示，到了以后按剩下的时间写，过了解散时间不提示 */
    @Test
    fun expireTipFollowsTheClock() {
        val g = view("viewMember")
        val end = parseIso(g.endAt)!!.toEpochMilli()
        val expire = parseIso(g.expireAt)!!.toEpochMilli()
        assertNull(expireTip(g, end - 1000))
        assertEquals("已到结束时间，这个群 3 天后自动解散", expireTip(g, end + 1000))
        assertEquals("已到结束时间，这个群 5 小时后自动解散", expireTip(g, expire - 5 * 3_600_000L))
        assertEquals("已到结束时间，这个群不到 1 小时后自动解散", expireTip(g, expire - 60_000))
        assertNull(expireTip(g, expire + 1))
        assertEquals("行程已结束，这个群 3 天后自动解散", expireTip(g.copy(kind = "trip"), end + 1000))
        assertEquals("活动已结束，这个群 3 天后自动解散", expireTip(g.copy(kind = "event"), end + 1000))
        // 没有结束时间的群（不会自动解散）不提示
        assertNull(expireTip(g.copy(endAt = null, expireAt = null), end + 1000))
    }

    /** 群的推送：拿推送里的群信息直接改页面；我自己的状态要自己算，我的身份、成员名单要留着 */
    @Test
    fun pushesUpdateTheGroup() {
        assertEquals(1, event("create").group.memberCount)
        val join = event("join")
        assertEquals(memberId, join.userId)
        assertEquals(memberName, join.nickname)
        assertEquals(2, join.group.memberCount)

        // 成员这边：改群名和公告 → 被移出
        var mine = view("viewMember").merged(event("info"), memberId)
        assertTrue(mine.name.startsWith("样本群改名"))
        assertEquals("早上 7 点集合\n带身份证", mine.notice)
        assertEquals("ok", mine.state)
        assertEquals("member", mine.role)
        assertEquals(2, mine.members.size)
        mine = mine.merged(event("kick"), memberId)
        assertEquals("kicked", mine.state)
        assertEquals(1, mine.memberCount)
        // 被移出以后这个群再怎么变（比如解散了），对我来说还是「你已不在这个群里」
        assertEquals("kicked", mine.merged(event("dissolved"), memberId).state)

        // 群主这边：别人被移出，我还是正常的 → 解散
        var own = view("viewOwner").merged(event("kick"), ownerId)
        assertEquals("ok", own.state)
        assertEquals("owner", own.role)
        assertEquals(1, own.memberCount)
        own = own.merged(event("dissolved"), ownerId)
        assertEquals("dissolved", own.state)
        assertEquals("owner", own.role)

        // 退出过又重新进群：变回正常；别人进群不影响「我已经不在了」
        assertEquals("ok", stateAfter(join, memberId, "left"))
        assertEquals("left", stateAfter(join, "999", "left"))
    }

    /** 群里的消息：实时来的、聊天记录里的、灰色小字、回复、表情、置顶 */
    @Test
    fun groupMessages() {
        val m = payload("msg")
        assertEquals(2, m.convType)
        assertEquals(gid, m.groupId)
        assertEquals(cid, m.conversationId)
        assertNull(m.receiverId)
        assertEquals(memberName, m.senderNickname)

        val sys = payload("sysJoin")
        assertEquals("sys", sys.type)
        assertEquals("$memberName 加入了群聊", sysText(sys.content))

        assertEquals(m.id, payload("msgReply").replyTo?.id)

        val list = Api.json.decodeFromJsonElement(ListSerializer(MsgItem.serializer()), fx["messagesMember"]!!)
        assertEquals("sys", list.first().type)
        assertEquals("群聊已建好", sysText(list.first().content))
        val last = list.last()
        assertEquals(m.id, last.replyTo?.id)
        assertEquals(listOf(memberId), last.reactions.single().userIds)
        assertFalse(last.pending)

        val pins = Api.json.decodeFromJsonElement(ListSerializer(PinItem.serializer()), fx["pins"]!!)
        assertEquals(listOf(m.id), pins.map { it.id })

        // 不是灰色小字的内容不要被当成灰色小字
        assertEquals("", sysText("随便一句话"))
    }

    /** 群用不了时服务器给的原因：WebSocket 的 error 帧带 code，接口报错带 reason */
    @Test
    fun refusalsCarryTheReason() {
        assertEquals("left", groupReasonState(frame("errorLeft")["code"]?.jsonPrimitive?.content))
        assertEquals("dissolved", groupReasonState(frame("errorDissolved")["code"]?.jsonPrimitive?.content))
        val http = Api.json.decodeFromJsonElement(ApiResp.serializer(), fx["http403"]!!)
        assertEquals(403, http.code)
        assertEquals("left", groupReasonState(http.reason))
        assertEquals("closed", groupReasonState("group_closed"))
        // 别的原因（比如对方结束了聊天）不是群的事
        assertNull(groupReasonState("chat_ended"))
        assertNull(groupReasonState(null))
        assertEquals("这个群因违规已被平台关闭", groupEndText("closed"))
    }

    /** 搜索：群里的消息搜得到，带着是哪个群 */
    @Test
    fun searchFindsGroupMessages() {
        val r = Api.json.decodeFromJsonElement(SearchResp.serializer(), fx["search"]!!)
        val hit = r.messages.single()
        assertEquals(2, hit.convType)
        assertEquals(gid, hit.targetId)
        assertEquals(cid, hit.conversationId)
        assertTrue(hit.title.startsWith("样本群"))
    }
}
