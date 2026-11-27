package com.wh.hongniang

import com.wh.hongniang.net.Api
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 大厅页和它唤起的全屏网页只允许打开我们自己的网页（[Api.isOwnWebUrl]）。
 * 这里把「应该放行的」和「看起来像自己的、其实是别人的」各列一批，防止以后改这个判断时放宽了。
 */
class OwnWebUrlTest {
    private val base = Api.BASE_URL

    @Test
    fun ownPagesAreAllowed() {
        listOf(
            "$base/#/hall-embed?token=abc&embed=1&lang=zh",
            "$base/site/#/hall-embed",
            "$base/games/story/index.html?uid=1",
            "https://gphnai.com/",
            "https://www.gphnai.com/activity/1",
            "https://h5.gphnai.com/#/x",
            "HTTPS://WWW.GPHNAI.COM/a",
            "  https://gphnai.com/a  ",
        ).forEach { assertTrue("应该放行：$it", Api.isOwnWebUrl(it)) }
    }

    @Test
    fun otherSitesAreRefused() {
        listOf(
            null,
            "",
            "about:blank",
            "javascript:alert(1)",
            "file:///sdcard/a.html",
            "intent://gphnai.com/#Intent;end",
            "weixin://gphnai.com/",
            "https://example.com/",
            "https://example.com/?next=https://gphnai.com/",
            "https://example.com/#.gphnai.com",
            "https://example.com/gphnai.com",
            // 主机名里带着我们的域名、但不是它的子域名
            "https://gphnai.com.example.com/",
            "https://xgphnai.com/",
            "https://notgphnai.com/",
            // 把我们的域名写在「用户名」的位置，真正的主机是后面那个
            "https://gphnai.com@example.com/",
            "https://gphnai.com:pw@example.com/",
            "https://example.com\\@gphnai.com/",
            "https://example.com%2F@gphnai.com.example.org/",
            // 旧的 IP 地址（2026-11-27 换成域名以后不再算自己的）和它的近似写法
            "http://120.55.59.158/",
            "http://120.55.59.1580/",
            "http://120.55.59.158.example.com/",
            "//gphnai.com/a",
            "gphnai.com/a",
        ).forEach { assertFalse("应该拦下：$it", Api.isOwnWebUrl(it)) }
    }
}
