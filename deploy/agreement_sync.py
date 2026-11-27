# -*- coding: utf-8 -*-
"""
用户协议、隐私政策的正文只写在这里，运行一次同步到三端的翻译文件和网页的两个静态页：
  web/src/i18n/locales/{zh,en}.json          agreement.web.user / agreement.web.privacy
  android/app/src/main/assets/i18n/{zh,en}.json   agreement.userBody / agreement.privacyBody
  ios/Hongniang/Hongniang/i18n/i18n_{zh,en}.json  agreement.userBody / agreement.privacyBody
  web/public/terms.html、privacy.html         中英两段正文
顺手改掉几条还提到已删功能的文案（扫码提示、转发提示、保活通知标题）。

以后改协议只改这个文件，然后在仓库根目录运行：python deploy/agreement_sync.py

2026-11-25 重写的原因：原来的正文讲的是积分、礼物、约单、线下仲裁这些已经删掉的功能，
和现在的 App 对不上（应用商店审核会认为这些功能还在、只是藏起来了）；也没写 AI、真人认证、换设备找回。
这一版是按 App 现在实际做的事情写的，**没有经过律师审，上线前要让律师看一遍**。
"""
import io
import json
import os
import re
from collections import OrderedDict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 静态网页里显示的应用名（翻译文件里用 {app} 占位，由各端自己填）
APP = {'zh': '一线牵', 'en': 'Yixianqian'}

USER = {}
PRIVACY = {}

USER['zh'] = '''欢迎使用{app}（以下简称"本平台"）。本平台是面向成年人的相亲交友服务。请在使用前仔细阅读本协议，使用本平台即表示您同意以下条款。

一、年龄限制
本平台仅面向年满 18 周岁的成年人。注册或使用本平台即表示您确认已年满 18 周岁。若发现用户未满 18 周岁，平台有权立即终止服务并注销账号。

二、账号规则
1. 账号与设备自动绑定，无需密码；同一台设备卸载重装后可直接恢复账号。
2. 一个人只能有一个账号。完成真人认证后，一张身份证只对应一个账号；更换设备时，可通过身份证加刷脸回到原来的账号。
3. 注册时选择的性别不可修改，请如实填写。
4. 账号仅限本人使用，不得出售、出租、转让。

三、真实资料
1. 您填写的相亲资料（包括年龄、身高、学历、职业、收入、婚史、对彩礼和婚育的想法等）会展示给平台推荐给您的异性用户，请如实填写。
2. 您在 AI 访谈中自述的、可能影响对方判断的重要情况（例如婚史、负债、不良嗜好等），会如实记入您的相亲画像并展示给对方，您无法自行删除。
3. 真人认证只表示该用户的身份经过核验、已满 18 周岁，不代表平台对其品行、资料真实性或婚恋意图作出保证。

四、行为规范
使用本平台时，您承诺不发布、传播以下内容，不从事以下行为：
1. 违反法律法规的内容；
2. 色情、赌博、暴力、恐怖内容；
3. 骚扰、辱骂、诽谤他人的内容；
4. 诈骗、虚假宣传或垃圾广告信息；
5. 以相亲为名索要财物、诱导转账或投资。
违反上述规范的，平台有权删除内容、限制功能或永久封禁账号。

五、牵豆、AI 功能与费用
1. "牵豆"是本平台内用于支付下列费用的预付额度，1 牵豆对应人民币 1 元。
2. 视频见面按通话时长收取牵豆，由男方支付；接通后开始计算，不满 1 分钟按 1 分钟计算。每分钟的价格以发起或接听视频前页面展示的为准。支付方的牵豆不足时，视频会自动结束。发消息和语音通话不收取牵豆。
3. 平台中的 AI 红娘访谈、相亲画像整理、推荐理由、开场白等内容由人工智能生成，可能存在不准确之处，仅供参考，不构成任何承诺或建议。
4. AI 功能按实际使用量收取费用：使用牵豆支付时，按模型服务商的实际费用另加 10% 服务费扣除；使用您自己填写的模型密钥时，平台不收取费用。
5. 真人认证按认证服务商的成本价收取牵豆，具体数量以页面展示为准。
6. 牵豆仅用于支付上述费用，没有使用期限；不可兑换为现金或其他财物，不可转让给他人。

六、相亲与线下见面
1. 平台仅提供信息展示和匹配推荐，不参与用户之间的交往，也不经手彩礼等任何款项。
2. 见面请选择公共场所并告知亲友；在确认对方身份和意图之前，请勿向对方转账或出借财物。
3. 用户之间因交往产生的纠纷由双方自行解决，平台在法律规定的范围内配合有关部门处理。

七、内容责任
您在平台发布的资料、动态、评论、消息等内容由您本人负责。平台有权对违规内容进行处理并配合监管部门调查。

八、服务变更与终止
平台有权根据运营需要变更、暂停或终止部分或全部服务，重大变更将提前公告。

九、协议修改
平台可能不时修改本协议，修改后的协议在平台内公布后生效。继续使用即视为接受修改。'''

USER['en'] = '''Welcome to {app} (the "Platform"). The Platform is a matchmaking service for adults who are looking for a marriage partner. Please read this Agreement carefully before using the Platform. By using the Platform, you agree to the following terms.

1. Age restriction
The Platform is intended only for adults aged 18 or older. By registering for or using the Platform, you confirm that you are at least 18. If we find that a user is under 18, we may immediately terminate the service and delete the account.

2. Account rules
(1) Your account is bound to your device automatically and needs no password. Reinstalling the app on the same device restores the account.
(2) One person may have only one account. After identity verification, one ID card corresponds to one account. When you change devices, you can return to your account with your ID number and a face scan.
(3) The gender chosen at registration cannot be changed. Please fill it in truthfully.
(4) The account is for your own use only and may not be sold, rented or transferred.

3. Truthful profile
(1) Your matchmaking profile (including age, height, education, occupation, income, marital history and your views on betrothal gifts, marriage and children) is shown to users of the opposite sex that the Platform recommends to you. Please fill it in truthfully.
(2) Important facts you state in the AI interview that may affect the other person's decision (for example marital history, debts or harmful habits) are recorded in your profile as stated and shown to the other person. You cannot delete them yourself.
(3) Identity verification only means that the user's identity has been checked and that the user is 18 or older. It is not a guarantee by the Platform of the user's character, the truthfulness of the profile or the user's intentions.

4. Code of conduct
When using the Platform, you agree not to publish or spread the following content or engage in the following conduct:
(1) content that violates laws or regulations;
(2) pornographic, gambling, violent or terrorist content;
(3) content that harasses, insults or defames others;
(4) fraud, false advertising or spam;
(5) asking for money or property, or inducing transfers or investments, under the pretext of matchmaking.
If you violate these rules, we may remove the content, restrict features or permanently ban the account.

5. Qiandou, AI features and fees
(1) "Qiandou" is prepaid credit used on the Platform to pay the fees below. 1 Qiandou corresponds to RMB 1.
(2) Video calls are charged in Qiandou by duration and are paid by the male user. Charging starts when the call is answered, and less than one minute counts as one minute. The price per minute is the one shown on the page before you start or answer a video call. A video call ends automatically when the paying user runs out of Qiandou. Messages and voice calls are not charged.
(3) The AI matchmaker interview, profile summary, recommendation reasons, conversation starters and similar content are generated by artificial intelligence. They may be inaccurate, are for reference only and do not constitute any promise or advice.
(4) AI features are charged by actual usage. When you pay with Qiandou, we deduct the model provider's actual cost plus a 10% service fee. When you use your own model API key, the Platform charges nothing.
(5) Identity verification is charged in Qiandou at the verification provider's cost. The exact amount is shown on the page.
(6) Qiandou can only be used to pay the fees above and does not expire. It cannot be exchanged for cash or anything else, and cannot be transferred to another person.

6. Matchmaking and meeting in person
(1) The Platform only displays information and recommends matches. It does not take part in the relationship between users and does not handle betrothal gifts or any other payment between users.
(2) Meet in a public place and tell family or friends. Do not transfer money or lend property to the other person before you are sure of their identity and intentions.
(3) Disputes between users arising from their relationship are resolved by the users themselves. The Platform cooperates with the authorities as required by law.

7. Responsibility for content
You are responsible for the profile, moments, comments, messages and other content you publish on the Platform. We may handle content that violates the rules and cooperate with regulators.

8. Changes to and termination of the service
We may change, suspend or terminate part or all of the service as our operations require. Major changes will be announced in advance.

9. Changes to this Agreement
We may modify this Agreement from time to time. The modified Agreement takes effect once published on the Platform. Continued use means that you accept the changes.'''

PRIVACY['zh'] = '''{app}（以下简称"本平台"）非常重视您的隐私。本政策说明我们如何收集、使用和保护您的信息。

一、我们收集的信息
1. 注册信息：昵称、头像、年龄、性别；
2. 相亲资料：您在问答和 AI 访谈中提供的身高、学历、职业、收入、婚史、兴趣、择偶要求等，以及据此生成的相亲画像；
3. 设备信息：设备标识符，用于账号与设备绑定、登录设备管理和账号找回；
4. 位置信息：在您授权后，用于同城推荐和距离显示；
5. 真人认证信息：认证时您填写的姓名、身份证号和刷脸影像由认证服务商核验，我们只保存"是否通过"和身份证号经不可逆处理后的摘要（用于一人一号和账号找回），不保存身份证号原文和人脸照片；
6. 使用记录：聊天消息、动态、通话记录、喜欢与匹配记录、AI 功能的用量、牵豆的收支明细；
7. 摄像头、麦克风、相册：仅在您进行刷脸认证、音视频通话、发送照片或语音时使用。

二、信息的使用
1. 提供核心功能：相亲画像、匹配推荐、消息收发、音视频通话、动态发布；
2. 向平台推荐给您的异性用户展示您的相亲画像；
3. 同城推荐与距离计算；
4. 账号安全、真人认证与违规行为处置；
5. 牵豆的结算与对账（视频见面、AI 功能、真人认证的费用）。

三、第三方服务
为实现相应功能，我们会把必要的信息提供给以下服务商处理：
1. 真人认证：阿里云（金融级实人认证），处理您的姓名、身份证号和刷脸影像；
2. 人工智能：DeepSeek（深度求索），处理您在 AI 访谈中输入的内容，以及用于生成相亲画像、推荐理由和开场白的相亲资料。
除此之外，我们不会向任何第三方出售您的个人信息；仅在获得您的明确同意，或法律法规要求、监管部门依法调取时提供。

四、信息的存储与保护
1. 聊天消息和 AI 访谈内容加密存储；
2. 您填写的模型密钥加密保存，页面只显示后四位；
3. 数据存储在中国境内的服务器。

五、您的权利
1. 您可以随时修改昵称、头像和相亲资料（AI 访谈中记入"需要注意"的内容除外）；
2. 您可以删除自己发布的动态、清空聊天记录；
3. 您可以在"登录设备"中查看和移除能登录您账号的设备；
4. 如需注销账号，可联系平台客服处理。

六、未成年人保护
本平台不向未满 18 周岁的用户提供服务。如发现未成年人使用，我们将立即注销相关账号并删除其信息。

七、政策更新
本政策可能不时更新，更新后将在平台内公布。'''

PRIVACY['en'] = '''{app} (the "Platform") takes your privacy seriously. This Policy explains how we collect, use and protect your information.

1. Information we collect
(1) Registration information: nickname, avatar, age and gender;
(2) Matchmaking profile: height, education, occupation, income, marital history, interests, partner preferences and similar information you provide in the questionnaire and the AI interview, and the profile generated from it;
(3) Device information: a device identifier, used to bind your account to your device, manage signed-in devices and recover your account;
(4) Location: with your permission, used for same-city recommendations and to show distance;
(5) Identity verification: the name, ID number and face scan you provide are checked by the verification provider. We keep only the result (passed or not) and an irreversible digest of the ID number (used for the one-person-one-account rule and account recovery). We do not keep the ID number itself or any face image;
(6) Usage records: chat messages, moments, call records, likes and matches, and AI feature usage, and your Qiandou top-up and spending records;
(7) Camera, microphone and photo library: used only when you do a face scan, make an audio or video call, or send photos or voice messages.

2. How we use information
(1) To provide core features: matchmaking profile, match recommendations, messaging, audio and video calls, and moments;
(2) To show your matchmaking profile to users of the opposite sex that the Platform recommends to you;
(3) Same-city recommendations and distance calculation;
(4) Account security, identity verification and handling of violations;
(5) Settlement and reconciliation of Qiandou (fees for video calls, AI features and identity verification).

3. Third-party services
To provide the relevant features, we give the necessary information to the following providers:
(1) Identity verification: Alibaba Cloud (ID Verification), which processes your name, ID number and face scan;
(2) Artificial intelligence: DeepSeek, which processes what you type in the AI interview and the profile information used to generate your profile summary, recommendation reasons and conversation starters.
Apart from this, we do not sell your personal information to any third party. We provide it only with your explicit consent, or when required by laws and regulations or lawfully requested by regulators.

4. Storage and protection
(1) Chat messages and AI interview content are stored encrypted;
(2) Your own model API key is stored encrypted, and only the last four characters are shown;
(3) Data is stored on servers located in mainland China.

5. Your rights
(1) You can change your nickname, avatar and matchmaking profile at any time (except items recorded as "things to note" in the AI interview);
(2) You can delete moments you posted and clear your chat history;
(3) You can view and remove the devices that can sign in to your account under "Signed-in devices";
(4) To delete your account, contact Platform support.

6. Protection of minors
The Platform does not provide services to users under 18. If we find that a minor is using the Platform, we will immediately delete the account and its information.

7. Updates to this Policy
This Policy may be updated from time to time. Updates will be published on the Platform.'''

# 几条还提到已删功能的文案
FIXES = {
    'zh': {
        'qr.scanPrompt': '对准邀请名片上的二维码',
        'chat.cantForward': '通话记录不能转发',
        'chat.partForward': '通话记录不会被转发',
        'msg.cantForward': '通话记录不能转发',
        'msg.someNotForwarded': '通话记录不会被转发',
        'notify.keepAliveTitle': '消息与来电',
    },
    'en': {
        'qr.scanPrompt': 'Point at the QR code on an invite card',
        'chat.cantForward': "Call records can't be forwarded",
        'chat.partForward': "Call records won't be forwarded",
        'msg.cantForward': "Call records can't be forwarded",
        'msg.someNotForwarded': "Call records won't be forwarded",
        'notify.keepAliveTitle': 'Messages and calls',
    },
}

TARGETS = [
    ('web/src/i18n/locales/%s.json', 'agreement.web.user', 'agreement.web.privacy'),
    ('android/app/src/main/assets/i18n/%s.json', 'agreement.userBody', 'agreement.privacyBody'),
    ('ios/Hongniang/Hongniang/i18n/i18n_%s.json', 'agreement.userBody', 'agreement.privacyBody'),
]


def main():
    for pattern, user_key, privacy_key in TARGETS:
        for lang in ('zh', 'en'):
            path = os.path.join(ROOT, pattern % lang)
            data = json.loads(io.open(path, encoding='utf-8').read(), object_pairs_hook=OrderedDict)
            changed = []
            for key, value in ((user_key, USER[lang]), (privacy_key, PRIVACY[lang])):
                if key not in data:
                    raise SystemExit('%s 里没有 %s' % (pattern % lang, key))
                if data[key] != value:
                    data[key] = value
                    changed.append(key)
            for key, value in FIXES[lang].items():
                # 只改这个文件里本来就有的条目，不新增
                if key in data and data[key] != value:
                    data[key] = value
                    changed.append(key)
            io.open(path, 'w', encoding='utf-8', newline='\n').write(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
            print('%s：改了 %d 条 %s' % (pattern % lang, len(changed), ' '.join(changed)))

    for name, texts in (('terms.html', USER), ('privacy.html', PRIVACY)):
        path = os.path.join(ROOT, 'web', 'public', name)
        html = io.open(path, encoding='utf-8').read()
        for lang in ('en', 'zh'):
            body = texts[lang].replace('{app}', APP[lang]).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            rx = re.compile(r'(<div class="doc" data-l="%s">).*?(</div>)' % lang, re.S)
            html, n = rx.subn(lambda m: m.group(1) + body + m.group(2), html, count=1)
            if n != 1:
                raise SystemExit('%s 里没找到 %s 那一段' % (name, lang))
        io.open(path, 'w', encoding='utf-8', newline='\n').write(html)
        print('web/public/%s：两段正文已换' % name)


if __name__ == '__main__':
    main()
