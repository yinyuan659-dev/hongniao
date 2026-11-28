package com.wh.hongniang

import com.wh.hongniang.net.Api
import com.wh.hongniang.ui.screen.TripPinInfo
import com.wh.hongniang.ui.screen.tripDateText
import com.wh.hongniang.ui.screen.yuanText
import org.junit.Assert.assertEquals
import org.junit.Test

/** 线路群聊天页顶上那张线路卡：日期、价格怎么写；服务器的线路详情能不能读出卡片要的几项 */
class TripPinTest {
    @Test
    fun date() {
        assertEquals("12 月 8 日", tripDateText("2026-12-08", thisYear = 2026))
        // 不是今年的带上年份
        assertEquals("2027 年 1 月 3 日", tripDateText("2027-01-03", thisYear = 2026))
        // 不是日期的样子：原样返回，不崩
        assertEquals("", tripDateText("", thisYear = 2026))
        assertEquals("12-08", tripDateText("12-08", thisYear = 2026))
        assertEquals("2026-xx-08", tripDateText("2026-xx-08", thisYear = 2026))
    }

    @Test
    fun price() {
        assertEquals("¥3,980", yuanText(3980))
        assertEquals("¥680", yuanText(680))
        assertEquals("¥12,000", yuanText(12000))
    }

    /** 服务器 GET /trip/detail/:id 返回的样子（2026-11-28 实测的字段，多出来的项不该让解析失败） */
    @Test
    fun decode() {
        val body = """{"id":"11","leaderId":"5","title":"【自测】川西环线 7 天","videoUrl":"/res/hongniang/video/a.mp4","coverUrl":"/res/hongniang/image/a.jpg",
            "startDate":"2026-12-08","days":7,"gatherPlace":"成都","price":3980,"quota":6,"left":6,"orders":0,"phase":"open",
            "itinerary":"第 1 天","feeNote":"含车辆","status":1,"leader":{"id":"5","nickname":"测试·小周","avatar":"","intro":"","rank":1,"orders30":0,"trips":1},
            "faces":[],"btn":"joined","group":{"id":"38","conversationId":"42","name":"川西环线 12-08 团"}}"""
        val t = Api.json.decodeFromString(TripPinInfo.serializer(), body)
        assertEquals("11", t.id)
        assertEquals("【自测】川西环线 7 天", t.title)
        assertEquals("/res/hongniang/image/a.jpg", t.coverUrl)
        assertEquals("2026-12-08", t.startDate)
        assertEquals(3980, t.price)
    }
}
