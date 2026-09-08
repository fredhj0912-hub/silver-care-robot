# 운영 메모 — 돌아가는 것을 계속 돌아가게 하는 값들

TODO.md 에서 옮겨 왔다(2026-09-08). 할 일이 아니라 **일하다 막혔을 때 찾아볼 사실들**이라
작업 목록에 섞여 있을 이유가 없었다. 여기 있는 값은 전부 실측이다 — 추측이면 그렇게 적혀 있다.

**네트워크가 바뀌면 EC2·RDS가 통째로 막힌다** — 둘 다 개발 PC 공인 IP `/32` 하나로만 열려 있고,
증상은 연결 거부가 아니라 **타임아웃**이다. `https://checkip.amazonaws.com` 으로 새 IP를 확인해
**CloudShell**에서 보안 그룹에 넣거나 **EC2 Instance Connect**로 우회한다(`docs/pi-runbook.md` §0-A).

**RDS** — 08-31에 EC2까지 전환 완료(`DB_DRIVER=sqlite`로 즉시 되돌아간다). **팀원과 같은**
**`silvercare` DB**(우리 7개 + 팀원 3개). 같은 VPC라 **보안 그룹 참조로 열어야 한다**(공인 IP
규칙은 EC2 경로에 안 먹는다). **로컬 `.env`도 pg를 본다** → 로컬 대화 테스트가 실제 RDS에 쌓인다.
**테스트는 항상 SQLite로 돈다**(각 테스트가 핀을 박는다. 빼면 `retention.test.js`가 실제 RDS를 지운다).

**⚠️ 드라이버를 건드리면 `npm run verify-rds`를 반드시 돌릴 것** — `pg-driver.test.js`는
pg-mem으로 도는데 **트랜잭션 롤백**·**COUNT/id 타입**·**`DO UPDATE ... WHERE` 가드**(09-07 추가) 셋은
코드를 망가뜨려도 통과한다. 셋 다 `verify-rds`가 실제 RDS에서 검사한다.

**EC2의 `TTS_PROVIDER=gemini`** (09-01). 파이에서 브라우저 TTS가 무음이라 서버측으로 돌렸다.
원래 `.env`에 **없던 줄**이라 EC2를 새로 만들면 **다시 넣어야 로봇이 말을 한다.**

**실측 지연** (quick tunnel 경유):
- 폰 `/guardian/send` → 파이 발화 **5초 안팎** (폴링 대기 1.25초 + 음성 생성 1~3초 + 전송).
  캐시된 문구는 생성 구간이 사라진다
- **받아쓰기**: 같은 3.6초 오디오가 **3.0 / 3.4 / 20.3 / 52.3초**. 느린 쪽은 전부 503 재시도라
  시한(`STT_TIMEOUT_MS`, 12초)을 넣었다. **원격조종 왕복 206~227ms**, 손 뗀 뒤 정지 0.9초 (09-03)

**서버측 STT가 감수하는 것** — 말이 **끝나야** 시작한다(침묵 0.9초 감지 → 업로드 → 받아쓰기).
~~방 안의 모든 발화가 올라간다~~는 09-07 푸시투토크로 사라졌다 — 이제 버튼을 눌러야 열린다.

**파이 실측값** — `KIOSK_ROTATE=180`(터치 좌표도 회전) / 출력 `UACDemoV1.0` · 입력 `reSpeaker 4-Mic
Array` / **`git config core.fileMode false`** 를 걸어 뒀다(안 그러면 `chmod +x`가 `git pull`을 막는다).

**개발 PC(윈도우)에도 같은 설정이 필요하다** (09-08에 겪었다). 안 걸면 `deploy/pi/`의 스크립트
8개가 **내용 변화 없이 모드만 755 → 644로 바뀐 채** 잡히고, 그대로 커밋하면 실행 비트가
레포에서 사라져 **파이 키오스크가 안 뜬다** — 09-06에 고친 그 버그가 그대로 돌아온다.
각 개발 PC에서 한 번: `git config core.fileMode false`.

**배포된 앱의 알려진 한계 3가지** (상세는 `docs/deploy-ec2-production.md`): ① quick tunnel은
**SSE를 통과시키지 못한다**(응급 푸시는 FCM 직통이라 무사, 보호자 앱은 30초 폴백 폴링).
② **터널 주소가 재시작마다 바뀐다** → **푸시 구독을 다시 해야 한다.** ③ `ROBOT_API_KEY`는 진짜 인증이 아니다.

**인스턴스**는 `t3.small`(1.9Gi). `t3.nano`는 `@aws-sdk/client-s3` 설치에서 OOM 위험.
**stop/start하면 IP가 바뀐다**(reboot은 유지) → `npm run access -- <새 IP>` (끌 때 `--stopped`).

**로컬에서 HTTPS로 폰 테스트할 때** — `npm run dev`가 아니라 **preview를 터널링**해야 한다(서비스
워커는 프로덕션 빌드에만 등록된다). `npm run build && npm run preview`(4173) + cloudflared 터널 하나.

---
