# EC2 상시 배포 (백엔드 + 보호자 PWA)

노트북을 켜 두지 않아도 보호자 앱이 살아 있게 만드는 배포다. 백엔드가 프론트엔드
빌드까지 같은 오리진에서 서빙하고, HTTPS는 EC2 안에서 도는 cloudflared 터널로 얻는다.

**S3 연결만 확인하는 절차는 이 문서가 아니라 `docs/deploy-ec2-aws-test.md`다.**

> **✅ 2026-08-29 실제로 이 절차를 밟아 배포·검증 완료.** 아래는 전부 실측이다.
> 인스턴스 `i-0459de4bc22c04d52`(`t3.small`, Amazon Linux 2023, `us-west-2`),
> Node 24.20.0(nvm), cloudflared 2026.8.2, 버킷 `project9-80-oregon-hyodol-snapshots`.

---

## 왜 cloudflared인가 (다른 선택지가 없다)

이 앱의 핵심 기능은 전부 **보안 컨텍스트(HTTPS)** 를 요구한다 — 서비스 워커와 Web Push,
카메라(`getUserMedia`), 마이크(Web Speech). `http://<퍼블릭IP>`로는 하나도 동작하지 않는다.

그런데 대회 계정 허용 목록(EC2·Lambda·RDS·DynamoDB·S3·API GW·Amplify·SQS·SNS)에는
**ALB도 CloudFront도 없어서 ACM 인증서를 붙일 곳이 없다.** API Gateway는 HTTPS를 주지만
응답을 버퍼링해 SSE가 깨진다. 도메인 없이 HTTPS를 얻는 경로가 cloudflared뿐이다.

부수 이점: 터널은 **아웃바운드 전용**이라 인바운드 포트를 하나도 열지 않아도 된다.
이 인스턴스는 S3 쓰기 권한을 갖고 있으므로 노출면이 작을수록 좋다. **보안 그룹은 SSH 22번만
열어 둔다(소스: 내 IP + `com.amazonaws.us-west-2.ec2-instance-connect` 접두사 목록).**

---

## ⚠️ 알려진 한계 — 반드시 먼저 읽을 것

### 1. quick tunnel은 SSE(실시간 푸시 채널)를 통과시키지 못한다

**2026-08-29 실측.** `GET /api/events`가 터널 경유로는 **본문 0바이트**다. 응답 헤더는
정상(`HTTP 200`, `content-type: text/event-stream`)인데 본문만 안 온다.

앱 문제가 아니라는 것을 격리 검증했다 — 우리 코드와 무관한 최소 청크 서버(초당 한 줄
`res.write`)를 별도 포트에 띄워 같은 터널에 물렸더니 로컬 직결은 정상, 터널 경유는 10초간
0바이트였다. QUIC/HTTP/2 두 전송 프로토콜 모두 동일하고, 2KB 패딩 우회도 안 통했다.
`routes/events.js`는 이미 올바른 헤더(`no-transform`, `X-Accel-Buffering: no`)를 보낸다.
**`trycloudflare.com` 무료 quick tunnel의 엣지 버퍼링이고 코드로 고칠 수 없다.**

**영향과 영향이 아닌 것:**
- **응급 푸시는 멀쩡하다.** Web Push는 브라우저↔FCM 직통이라 이 터널을 지나지 않는다.
  실기기에서 낙상 알림 도착 → 상세 딥링크 → 해제까지 확인했다. **가장 중요한 경로는 살아 있다.**
- 보호자 앱은 `useGuardianData.js`의 **30초 폴백 폴링**으로 동작한다. 화면을 열어 둔 상태에서
  알림이 뜨기까지 최대 30초 밀린다.
- 부작용: SSE가 열리기만 하고 이벤트가 안 오므로 60초마다 "정체"로 판정돼 `connected`가
  false로 떨어진다 → **"오프라인" 안내가 깜빡일 수 있다.** (미수정, TODO.md 백로그)

고정 주소와 실시간이 동시에 필요해지면 **도메인 + Let's Encrypt 직결**로 가야 한다.
중간에 아무것도 없으니 SSE가 확실히 동작한다. 포트 80/443 개방과 certbot이 추가된다.

### 2. 터널 주소는 재시작할 때마다 바뀐다

주소가 바뀌면 브라우저 기준 다른 사이트라 **푸시 구독을 다시 해야 한다.** 현재 주소:

```bash
journalctl -u cloudflared.service --no-pager -o cat | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
```

### 3. `ROBOT_API_KEY`는 진짜 인증이 아니다

`VITE_ROBOT_API_KEY`로 프론트 번들에 평문으로 들어간다(`middleware/index.js` 주석 참고).
인터넷에 노출된 지금은 **"터널 주소를 아는 사람만 쓴다"** 수준이다. 주소를 아는 사람은
번들에서 키를 읽어 SOS·카메라·원격조종 API를 부를 수 있다. 시연·발표용으로 수용한 값이며,
제대로 된 보호자 로그인은 TODO.md 백로그에 있다. 최소한 로컬 개발 키를 재사용하지 말고
`openssl rand -hex 32`로 새로 뽑을 것.

---

## 1. 인스턴스 준비

`docs/deploy-ec2-aws-test.md` §1~3 그대로다. 요약하면:

```bash
sudo dnf install -y git                      # AL2023엔 git이 없다
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc && nvm install 24           # node:sqlite 때문에 ≥22.5
git clone https://github.com/fredhj0912-hub/silver-care-robot.git
cd silver-care-robot/backend && npm install
cd ../frontend && npm install
```

IAM 인스턴스 프로필 `SafeInstanceProfile-{username}` 부착은 **인스턴스 생성 후 별도 단계**다.
안에서 확인할 때는 IMDSv2 토큰이 필요하고, 보이는 이름은 `SafeRole-{username}`인 게 정상이다.

`t3.small`(1.9Gi)이면 충분하다. `npm install` ×2 + 프론트 빌드 + 백엔드 상시 기동까지
돌려 여유 1.1Gi 이상이었다.

## 2. 설정 — **순서가 중요하다**

`VITE_*` 값은 **빌드 시점에 번들에 박힌다.** `frontend/.env`를 반드시 `npm run build`
_전에_ 써야 한다. 뒤집으면 키가 빠진 번들이 나오고 증상은 "모든 API가 401"이다.

```bash
cd ~/silver-care-robot
ROBOT_API_KEY=$(openssl rand -hex 32)
VAPID_JSON=$(cd backend && npx --yes web-push generate-vapid-keys --json)

cat > frontend/.env <<EOF
VITE_ROBOT_API_KEY=$ROBOT_API_KEY
VITE_VAPID_PUBLIC_KEY=$(node -e "console.log(JSON.parse(process.argv[1]).publicKey)" "$VAPID_JSON")
EOF

cat > backend/.env <<EOF
GEMINI_API_KEY=<로컬에서 옮긴 값>
PORT=3001
NODE_ENV=production
PUBLIC_DIR=/home/ec2-user/silver-care-robot/frontend/dist
ROBOT_API_KEY=$ROBOT_API_KEY
VAPID_PUBLIC_KEY=<위와 같은 값>
VAPID_PRIVATE_KEY=<generate-vapid-keys 결과>
VAPID_SUBJECT=mailto:<연락처>
SNAPSHOT_STORAGE=s3
AWS_REGION=us-west-2
S3_BUCKET=project9-80-oregon-hyodol-snapshots
EOF
chmod 600 backend/.env frontend/.env

cd frontend && npm run build     # 반드시 .env 를 쓴 뒤에
```

- **VAPID 키쌍은 이 배포 전용으로 새로 발급한다.** 오리진이 바뀌면 기존 구독은 어차피 무효다.
  **셋 다 있어야** 푸시가 켜진다 — 하나라도 비면 조용히 비활성화된다.
- **`AWS_ACCESS_KEY_ID`/`SECRET`은 넣지 않는다.** 대회 계정은 발급 자체가 불가능하고,
  인스턴스 프로필이 자동으로 처리한다.
- `PUBLIC_DIR`이 설정되면 백엔드가 `/`(키오스크)와 `/guardian/*`(보호자 앱)을 직접 서빙한다.
  같은 오리진이라 `lib/api.js`의 `API_BASE`(상대 경로)와 CORS 설정을 건드릴 필요가 없다.

**사전 점검** — 서비스로 올리기 전에 값싸게 확인한다:

```bash
cd backend && npm run verify-s3     # ✅ s3://<버킷>/s3-... 가 나와야 한다
```

## 3. systemd 등록

```bash
NODE_BIN=$(ls -d /home/ec2-user/.nvm/versions/node/*/bin/node | tail -1)
```

⚠️ **nvm은 로그인 셸에서만 PATH에 잡힌다.** systemd 유닛에는 `node` 절대 경로를 써야 한다.

`/etc/systemd/system/hyodol.service`:

```ini
[Unit]
Description=Hyodol backend (Express + SQLite)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/silver-care-robot/backend
ExecStart=/home/ec2-user/.nvm/versions/node/v24.20.0/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

cloudflared 설치와 `/etc/systemd/system/cloudflared.service`:

```bash
curl -sL -o /tmp/cloudflared.rpm \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm
sudo dnf install -y /tmp/cloudflared.rpm
```

```ini
[Unit]
Description=cloudflared quick tunnel -> localhost:3001
After=hyodol.service
Wants=hyodol.service

[Service]
Type=simple
User=ec2-user
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate --url http://localhost:3001
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hyodol.service cloudflared.service
```

## 4. 검증

**기동 배너에 ⚠️ 가 하나도 없어야 한다** — `describeStartup()`이 미설정 항목을 전부 찍는다.

```bash
journalctl -u hyodol.service -b --no-pager -o cat | head -12
URL=$(journalctl -u cloudflared.service --no-pager -o cat | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)
KEY=$(grep '^ROBOT_API_KEY=' ~/silver-care-robot/backend/.env | cut -d= -f2-)

curl -s -o /dev/null -w "%{http_code}\n" "$URL/guardian"          # 200
curl -s -o /dev/null -w "%{http_code}\n" "$URL/api/status"        # 401 (키 없음)
curl -s -o /dev/null -w "%{http_code}\n" -H "x-api-key: $KEY" "$URL/api/status"   # 200
```

**스냅샷 왕복**(터널 → EC2 → S3 → 터널). 실측 결과 `200`, 68 bytes, `PNG image data, 1 x 1`:

```bash
PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
RESP=$(curl -s -X POST "$URL/api/alerts" -H "x-api-key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"type\":\"manual_panic_button\",\"description\":\"배포 검증\",\"image\":\"$PNG\"}")
SNAP=$(node -e "console.log(JSON.parse(process.argv[1]).alert.snapshotUrl)" "$RESP")
curl -s -o /tmp/shot.png -w "%{http_code} %{size_download}\n" "$URL$SNAP?key=$KEY"   # ?key= 다, &key= 아니다
file /tmp/shot.png
```

**푸시(가장 중요)** — 폰에서 `$URL/guardian`을 열고 "응급 알림 받기"로 권한을 허용한 뒤:

```bash
cd ~/silver-care-robot/backend
ROBOT_API_KEY="$KEY" npm run mock-detector -- --type fall --confidence 0.92
journalctl -u hyodol.service --since "-60 seconds" --no-pager -o cat | grep PUSH
```

`[PUSH] 1/1대 발송 완료`가 찍히고 폰에 알림이 떠야 한다. 2026-08-29 실측: 알림 도착 →
클릭 시 상세 화면 딥링크 → "확인했어요" → DB에 `resolved=1, resolved_by=guardian`,
`robot_status.is_emergency=0` 까지 확인.

**재부팅 생존** — `상시` 배포의 핵심이므로 반드시 확인한다. 실측 약 30초 만에 복귀했고
두 서비스 모두 수동 개입 없이 `active`였다. **단, 터널 주소는 바뀐다.**

```bash
sudo reboot
# 30~60초 뒤 재접속
systemctl is-active hyodol.service cloudflared.service
```

## 5. 비용

`t3.small` 24시간 가동은 월 $15 안팎의 크레딧을 쓴다. **장기간 안 쓸 땐 중지(stop)한다** —
EBS는 남아 재시작하면 코드·설정이 그대로다. 단, **stop/start 시 퍼블릭 IP가 바뀐다**
(reboot은 안 바뀐다).
