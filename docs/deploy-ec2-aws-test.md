# EC2에서 S3 스냅샷 연결 확인하기

대회(한이음 드림업) 제공 AWS 계정은 **Access Key 발급이 금지**되어 있고 IAM Role로만
인증할 수 있다. IAM Role은 EC2/Lambda처럼 AWS 인프라 안에서 도는 프로세스에만 자동
부여되므로, **로컬 개발 환경에서는 S3 인증 자체가 불가능**하다.

이 문서는 스냅샷 저장소를 S3로 돌렸을 때 "실제로 연결이 되는지"만 최소 비용으로 확인하는
절차다. 상시 운영 배포(RDS 이전 등)는 TODO.md의 AWS 섹션에서 따로 다룬다.

> **✅ 2026-08-29 실제로 이 절차를 밟아 검증 완료.** 아래 내용은 그때 실측으로 교정한
> 것이다(이전 버전은 운영진 안내만 보고 쓴 것이라 빠진 단계가 있었다). 실측 환경:
> 리전 `us-west-2`, `t3.small`, Amazon Linux 2023, 버킷
> `project9-80-oregon-hyodol-snapshots`.

> **쓸 수 있는 서비스**: EC2, Lambda, RDS, DynamoDB, S3, API GW, Amplify, SQS, SNS.
> **Bedrock 등 클라우드 AI는 지원되지 않는다** — 대화/비전 분석은 Gemini API를 그대로 쓴다.

---

## 0. CloudShell로 버킷 준비 (EC2 없이, 가장 쌈)

AWS 콘솔의 **CloudShell**(콘솔 우상단 터미널 아이콘)은 로그인 세션의 임시 자격증명을
자동으로 쓴다. Access Key 없이 바로 AWS CLI를 쓸 수 있으므로, EC2를 만들기 전에
버킷 생성과 권한 확인을 여기서 먼저 끝내는 게 빠르다.

```bash
# 버킷 목록 확인
aws s3 ls

# 버킷 생성 — 이름은 반드시 본인 username으로 시작해야 한다 (대회 계정 규칙)
aws s3 mb s3://<username>-hyodol-snapshots --region <리전>
```

`AccessDenied`가 뜨면 역할에 S3 권한이 없는 것이니 대회 운영진에게 문의한다.

---

## 1. EC2 인스턴스 생성

콘솔 → EC2 → 인스턴스 시작:

- **인스턴스 타입**: `t3.nano` ~ `t3.small` (대회 계정 제한).
  **`t3.small` 권장** — 실측 결과 `t3.small`(1.9Gi)에서 `npm install`(주로
  `@aws-sdk/client-s3`) 후 여유 1.4Gi로 넉넉했다. `t3.nano`(512MB)는 OOM 위험이 있다.
- **리전**: 대회에서 전달받은 리전. 계정 username에 리전이 박혀 있으면
  (`project9-80-oregon` → Oregon = `us-west-2`) 그게 힌트다. CloudShell에서
  `aws configure get region`으로 확정할 수 있다.
- **AMI**: Amazon Linux 2023 (검증에 쓴 것) 또는 Ubuntu.
  **SSH 사용자 이름이 다르다** — AL2023은 `ec2-user`, Ubuntu는 `ubuntu`.
- **키 페어**: SSH 접속용으로 새로 만들거나 기존 것 선택.
  ⚠️ **키 페어는 인스턴스 생성 시에만 지정할 수 있다** — 나중에 추가가 안 되므로 반드시
  이때 만들어 `.pem`을 받아둔다. Windows에서는 받은 뒤 권한을 좁혀야 `ssh`가 거부하지
  않는다:
  ```powershell
  icacls "$env:USERPROFILE\Downloads\hyodol-key.pem" /inheritance:r
  icacls "$env:USERPROFILE\Downloads\hyodol-key.pem" /grant:r "$($env:USERNAME):R"
  ```

### 보안 그룹 (새로 만들어야 함)
인스턴스 생성 화면의 보안 그룹 섹션에서 **"새 보안 그룹 생성"** 선택:
1. 이름/설명 입력 후 생성
2. ⚠️ **생성 직후 태그가 자동으로 붙기까지 5~10초 지연**이 있다 — 태그가 붙어야
   인바운드 규칙 편집이 가능하니 잠시 기다린다
3. **인바운드** 규칙 추가 → 포트 범위 **22**(SSH) → 소스 **내 IP**(My IP, AWS 콘솔이
   자동으로 현재 IP를 채워준다) — S3 쓰기 권한이 있는 인스턴스라 SSH를 인터넷 전체에
   열어두면 안 된다. 아웃바운드는 기본값이 전체 허용이라 건드릴 필요 없다
   (nvm 다운로드·git clone·S3 호출이 전부 아웃바운드다)
4. **(장소를 옮겨 다닌다면) 인바운드 규칙을 하나 더** — 포트 22, 소스에 관리형 접두사
   목록 `com.amazonaws.<리전>.ec2-instance-connect`를 지정한다. 그러면 콘솔의
   「연결」(EC2 Instance Connect) 버튼이 **내 IP와 무관하게** 동작해서, 기숙사↔동아리방
   처럼 IP가 바뀌어도 규칙을 다시 편집할 필요가 없다.
   ⚠️ 이 규칙이 없으면 콘솔 「연결」이 `SendSSHPublicKey failed. Try again later.`로
   실패한다(2026-08-29에 실제로 겪음 — 권한 문제로 착각하기 쉽다)
5. EC2 생성 화면으로 돌아와 방금 만든 보안 그룹을 선택

### IAM 인스턴스 프로필 (생성 마법사가 아니라 생성 후 별도 단계)
인스턴스 생성 마법사에는 이 계정 전용 프로필이 안 보일 수 있다. **인스턴스 생성이
끝난 뒤** 인스턴스 목록에서 방금 만든 인스턴스를 선택 → **작업(Actions) → 보안
(Security) → IAM 역할 수정(Modify IAM role)** → `SafeInstanceProfile-{username}` 선택
→ 업데이트. **이 단계를 빼먹으면 S3 인증이 실패한다.**

접속한 뒤 **실제로 붙었는지 인스턴스 안에서 확인**할 수 있다. IMDSv2가 필수라 토큰을
먼저 받아야 한다(토큰 없이 `curl`하면 401이 떠서 "역할이 없다"고 오해하기 쉽다):

```bash
TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

여기서 나오는 이름은 **`SafeRole-{username}`** 이다 — 인스턴스 프로필
(`SafeInstanceProfile-{username}`)이 그 역할을 감싸는 구조라 정상이다. 이름이 다르다고
잘못 붙은 게 아니다. 아무것도 안 나오면 그때가 진짜 미부착이다.

> 트러블슈팅 1순위: 뭔가 안 되면 **리전부터 확인**하라고 운영진이 명시했다 — 지정
> 리전 밖에서는 모든 활동이 제한된다. 그리고 본인이 만든 리소스만 중지/시작/삭제할
> 수 있다.

## 2. Node.js 설치 (≥ 22.5)

`node:sqlite`를 쓰기 때문에 Node 22.5 이상이 필요하다. 배포판 기본 리포지토리에는
보통 없으므로 nvm으로 설치한다:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 24
node -v            # v24.x 확인
```

## 3. 코드 배포

백엔드만 있으면 확인이 되므로 전체를 올릴 필요는 없다.

**AL2023 기본 AMI에는 `git`이 없다** — 먼저 설치한다. 레포가 public이라 클론에 인증은
필요 없다.

```bash
sudo dnf install -y git
git clone https://github.com/fredhj0912-hub/silver-care-robot.git
cd silver-care-robot/backend
npm install
```

## 4. `.env` 작성

```bash
cp .env.example .env
vi .env
```

S3 확인에 필요한 값:

```
SNAPSHOT_STORAGE=s3
AWS_REGION=<대회에서 받은 리전>
S3_BUCKET=<0단계에서 만든 버킷 이름>
```

`GEMINI_API_KEY`도 넣어두면 서버 전체를 띄워 확인할 때 대화가 mock으로 안 떨어진다.

**`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`는 넣지 않는다** — 인스턴스 프로필이
자동으로 처리하고, 애초에 이 계정은 발급이 안 된다.

## 5. 연결 확인

```bash
npm run verify-s3
```

성공하면 저장된 S3 객체 경로(`s3://<버킷>/<파일명>`)가 찍힌다. 실패하면 에러 메시지에
원인(권한/버킷명/리전)이 안내되니 0단계로 돌아가 다시 짚어본다.

실제 출력(2026-08-29):

```
저장소: s3 (버킷: project9-80-oregon-hyodol-snapshots, 리전: us-west-2)
✅ S3 저장·조회 성공: s3://project9-80-oregon-hyodol-snapshots/s3-1788004134605-45b9c556.png
```

파일명이 `s3-`로 시작하는 것도 함께 확인하면 좋다 — `snapshots.js`가 저장 당시의
provider를 파일명에 새겨 두는 설계가 실환경에서 동작한다는 뜻이다.

**교차 검증**(SDK가 아닌 다른 경로로 한 번 더 본다. AL2023엔 AWS CLI가 기본 탑재):

```bash
aws s3 ls s3://<버킷>/ --region <리전>
```

## 6. (선택) 전체 서버로 end-to-end 확인

```bash
npm start
```

다른 터미널에서 낙상 이벤트를 흉내 내면 알림 생성 경로가 돈다:

```bash
npm run mock-detector -- --type fall --confidence 0.92
```

⚠️ **`mock-detector`는 이미지를 보내지 않는다** — 그래서 이 알림의 `snapshotUrl`은
`null`이고, 이것만으로는 **S3 경로가 전혀 검증되지 않는다.** 스냅샷 저장·서빙까지 보려면
`image`(데이터 URI)를 실어 SOS 알림을 직접 만든다:

```bash
PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
curl -s -X POST localhost:3001/api/alerts -H 'Content-Type: application/json' \
  -d "{\"type\":\"manual_panic_button\",\"description\":\"S3 검증\",\"image\":\"$PNG\"}"

# 응답의 snapshotUrl 을 그대로 열어 본다 (S3에서 읽어 프록시로 내려준다)
curl -s -o /tmp/shot.png -w "%{http_code} %{size_download}\n" \
  "localhost:3001/api/snapshots/<파일명>"
file /tmp/shot.png      # PNG image data ... 가 나와야 한다
```

2026-08-29 실측: `HTTP 200`, 68 bytes, `PNG image data, 1 x 1` — 저장→S3→서빙 왕복 성공.
`ROBOT_API_KEY`를 설정했다면 위 요청들에 `-H "x-api-key: <키>"`를 붙여야 한다.

> 외부(폰 등)에서 접근하려면 보안 그룹에서 해당 포트를 열어야 하지만, 연결 확인만이
> 목적이라면 EC2 안에서 localhost로 호출하는 것으로 충분하다.

## 7. 확인이 끝나면

**EC2 인스턴스를 중지(stop) 또는 종료(terminate)한다.** 켜둔 채로 두면 대회에서 할당한
크레딧이 계속 소모된다.
