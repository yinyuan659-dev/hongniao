# -*- coding: utf-8 -*-
"""
苹果发布证书（Apple Distribution）的两件事，在 Windows 上就能做，不需要 Mac：

  python deploy/ios_cert.py csr
      生成私钥和证书请求文件，放在 ios/signing/（这个目录不进 Git）。
      把 ios/signing/yixianqian-distribution.certSigningRequest 上传到苹果开发者后台，换回一个 .cer 证书。
      已经有私钥时不会覆盖（私钥换了，苹果发的证书就对不上了）。

  python deploy/ios_cert.py info <下载回来的 .cer 文件>
      读证书，打印 App 备案要填的：公钥、SHA-1 指纹，以及证书是发给谁的、什么时候到期。
      同时核对这张证书和 ios/signing/ 里的私钥是不是一对。

私钥文件 ios/signing/yixianqian-distribution.key 以后在 Mac 上打包要用，要另外备份。
这个脚本不会打印私钥。需要 Python 的 cryptography 库。
"""
import hashlib
import os
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, 'ios', 'signing')
KEY = os.path.join(DIR, 'yixianqian-distribution.key')
CSR = os.path.join(DIR, 'yixianqian-distribution.certSigningRequest')


def make_csr():
    os.makedirs(DIR, exist_ok=True)
    if os.path.exists(KEY):
        key = serialization.load_pem_private_key(open(KEY, 'rb').read(), password=None)
        print('私钥已经有了，沿用：', KEY)
    else:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        with open(KEY, 'wb') as f:
            f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
        print('新生成了私钥：', KEY)
    # 请求里写的名字苹果不采用（证书上的名字由苹果按开发者账号填），随便写一个能认出来的就行
    subject = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, 'Yixianqian Distribution'),
        x509.NameAttribute(NameOID.COUNTRY_NAME, 'CN'),
    ])
    csr = x509.CertificateSigningRequestBuilder().subject_name(subject).sign(key, hashes.SHA256())
    with open(CSR, 'wb') as f:
        f.write(csr.public_bytes(serialization.Encoding.PEM))
    print('证书请求文件：', CSR)
    print('下一步：把这个文件上传到苹果开发者后台 Certificates → 加号 → Apple Distribution。')


def load_cert(path):
    data = open(path, 'rb').read()
    if b'-----BEGIN CERTIFICATE-----' in data:
        return x509.load_pem_x509_certificate(data)
    return x509.load_der_x509_certificate(data)


def info(path):
    cert = load_cert(path)
    der = cert.public_bytes(serialization.Encoding.DER)
    pub = cert.public_key()
    if not isinstance(pub, rsa.RSAPublicKey):
        sys.exit('这张证书不是 RSA 的，备案表里的公钥这里取不出来')
    n = pub.public_numbers().n
    hexlen = (pub.key_size + 7) // 8 * 2
    print('证书是发给：', cert.subject.rfc4514_string())
    print('有效期到：  ', cert.not_valid_after_utc.strftime('%Y-%m-%d'))
    print()
    print('备案表里填的（都是公开信息）：')
    print('证书 SHA-1 指纹：', hashlib.sha1(der).hexdigest().upper())
    print('公钥（十六进制）：')
    print(format(n, '0%dX' % hexlen))
    print()
    print('备用：证书 MD5', hashlib.md5(der).hexdigest().upper(), '| SHA-256', hashlib.sha256(der).hexdigest().upper())
    if os.path.exists(KEY):
        key = serialization.load_pem_private_key(open(KEY, 'rb').read(), password=None)
        same = key.public_key().public_numbers() == pub.public_numbers()
        print('和 ios/signing/ 里的私钥是一对：', '是' if same else '不是（这张证书不是用这里的证书请求换来的）')
    else:
        print('ios/signing/ 里没有私钥，没法核对是不是一对')


if __name__ == '__main__':
    if len(sys.argv) >= 2 and sys.argv[1] == 'csr':
        make_csr()
    elif len(sys.argv) >= 3 and sys.argv[1] == 'info':
        info(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(2)
