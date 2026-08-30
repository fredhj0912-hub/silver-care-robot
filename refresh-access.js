/**
 * ACCESS.html 갱신 — 접속 주소를 한 파일에 모아 둔다.
 *
 *   npm run access -- 54.187.94.0    IP를 주고 갱신
 *   npm run access                   IP 생략 → 파일에 적힌 마지막 IP 재사용
 *   npm run access -- --stopped      인스턴스를 껐을 때
 *
 * 왜 필요한가: cloudflared quick tunnel 주소는 인스턴스를 껐다 켤 때마다 바뀐다.
 * 퍼블릭 IP 자체는 접속 주소가 아니다 — 보안 그룹에 22번만 열려 있고 앱은 터널로만
 * 열린다. 그래서 IP로 SSH해서 새 터널 주소를 읽어오는 이 한 단계가 필요하다.
 *
 * 환경변수(선택): HYODOL_SSH_KEY, HYODOL_SSH_USER
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OUT = path.join(__dirname, 'ACCESS.html');
const SSH_KEY = process.env.HYODOL_SSH_KEY || path.join(os.homedir(), 'Downloads', 'hyodol-key.pem');
const SSH_USER = process.env.HYODOL_SSH_USER || 'ec2-user';   // Amazon Linux 2023
const STATE_RE = /<!-- hyodol-state: (.*?) -->/;

/** 이전 실행이 HTML 안에 심어 둔 상태. 상태 파일을 따로 두지 않으려고 이렇게 한다. */
function readState() {
  try {
    return JSON.parse(fs.readFileSync(OUT, 'utf8').match(STATE_RE)[1]);
  } catch {
    return null;
  }
}

const REMOTE = `
URL=$(journalctl -u cloudflared.service --no-pager -o cat 2>/dev/null \
  | grep -oE 'https://[a-z0-9-]+\\.trycloudflare\\.com' | tail -1)
echo "tunnel=$URL"
echo "hyodol=$(systemctl is-active hyodol.service)"
echo "cloudflared=$(systemctl is-active cloudflared.service)"
echo "commit=$(cd ~/silver-care-robot 2>/dev/null && git log --oneline -1)"
`;

function fetchFromInstance(ip) {
  const stdout = execFileSync(
    'ssh',
    ['-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15',
     '-o', 'BatchMode=yes', `${SSH_USER}@${ip}`, 'bash -s'],
    { input: REMOTE, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  return Object.fromEntries(
    stdout.split('\n').filter((l) => l.includes('=')).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
  );
}

/** 주소를 적어만 두고 실제로는 죽어 있는 게 최악이라, 받은 주소를 직접 때려 본다. */
async function checkHealth(tunnel) {
  try {
    const res = await fetch(`${tunnel}/api/health`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return `응답 ${res.status}`;
    const body = await res.json();
    return body.ok ? 'ok' : '응답은 왔지만 ok=false';
  } catch (err) {
    return `실패 (${err.message})`;
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render({ ip, tunnel, hyodol, cloudflared, commit, health, stopped }) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const state = JSON.stringify({ ip, tunnel, updatedAt: new Date().toISOString() });
  const live = Boolean(tunnel) && !stopped;
  const healthOk = health === 'ok';

  const card = (id, icon, title, sub, url) => `
    <section class="card">
      <h2>${icon} ${esc(title)}</h2>
      <p class="sub">${esc(sub)}</p>
      <a class="url" href="${esc(url)}" target="_blank" rel="noreferrer">${esc(url)}</a>
      <div class="qr" id="${id}" data-url="${esc(url)}"></div>
      <p class="hint">QR을 폰 카메라로 찍으면 바로 열립니다.</p>
    </section>`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>효돌이 접속 주소</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, "Segoe UI", sans-serif; margin: 0; padding: 28px 18px 60px;
         background: #f6f7fb; color: #1a1a24; }
  @media (prefers-color-scheme: dark) { body { background: #16161e; color: #f1f2f6; } }
  .wrap { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .meta { color: #6b7280; font-size: .85rem; margin: 0 0 22px; }
  .status { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 24px; }
  .pill { font-size: .8rem; padding: 5px 11px; border-radius: 999px; font-weight: 700;
          background: #e5e7eb; color: #374151; }
  .pill.good { background: #10b981; color: #fff; }
  .pill.bad  { background: #ef4444; color: #fff; }
  .cards { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
  .card { background: #fff; border: 1px solid rgba(0,0,0,.08); border-radius: 16px; padding: 20px; }
  @media (prefers-color-scheme: dark) { .card { background: #21212c; border-color: rgba(255,255,255,.09); } }
  .card h2 { font-size: 1.1rem; margin: 0 0 2px; }
  .sub { color: #6b7280; font-size: .85rem; margin: 0 0 14px; }
  .url { display: block; word-break: break-all; font-family: ui-monospace, Consolas, monospace;
         font-size: .9rem; color: #4f46e5; font-weight: 700; text-decoration: none; margin-bottom: 14px; }
  .qr { display: flex; justify-content: center; min-height: 8px; }
  .qr img, .qr canvas { border-radius: 8px; background: #fff; padding: 8px; }
  .hint { color: #9ca3af; font-size: .78rem; text-align: center; margin: 10px 0 0; }
  .box { margin-top: 26px; background: #fff; border: 1px solid rgba(0,0,0,.08);
         border-radius: 16px; padding: 18px 20px; }
  @media (prefers-color-scheme: dark) { .box { background: #21212c; border-color: rgba(255,255,255,.09); } }
  .box h3 { margin: 0 0 10px; font-size: .95rem; }
  pre { background: rgba(127,127,127,.12); padding: 10px 12px; border-radius: 8px;
        overflow-x: auto; font-size: .82rem; margin: 0; }
  .warn { border-left: 4px solid #f59e0b; }
  ul { margin: 8px 0 0; padding-left: 20px; font-size: .88rem; line-height: 1.65; }
  .down { text-align: center; padding: 44px 20px; }
  .down h2 { font-size: 1.2rem; margin: 0 0 8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>🤖 효돌이 접속 주소</h1>
  <p class="meta">갱신: ${esc(now)} (KST) · 인스턴스 ${esc(ip || '알 수 없음')}</p>

  <div class="status">
    <span class="pill ${live && healthOk ? 'good' : 'bad'}">${live ? (healthOk ? '정상 동작 중' : '주소는 있으나 응답 없음') : '중지됨'}</span>
    ${stopped ? '' : `<span class="pill">백엔드 ${esc(hyodol || '?')}</span>
    <span class="pill">터널 ${esc(cloudflared || '?')}</span>
    <span class="pill">헬스체크 ${esc(health || '?')}</span>`}
  </div>

  ${live ? `<div class="cards">
    ${card('qr-pi', '📺', '라즈베리파이 5 — 로봇 화면', '로봇 얼굴이 나오는 키오스크 화면입니다', tunnel + '/')}
    ${card('qr-phone', '📱', '휴대전화 — 보호자 앱', '어르신 상태 확인과 응급 알림을 받는 화면입니다', tunnel + '/guardian')}
  </div>` : `<div class="card down">
    <h2>인스턴스가 꺼져 있습니다</h2>
    <p class="sub">AWS 콘솔에서 인스턴스를 시작한 뒤, 새 퍼블릭 IP로 아래를 실행하세요.</p>
    <pre>npm run access -- &lt;새 퍼블릭 IP&gt;</pre>
  </div>`}

  ${stopped ? '' : `<div class="box">
    <h3>SSH 접속</h3>
    <pre>ssh -i "${esc(SSH_KEY)}" ${esc(SSH_USER)}@${esc(ip)}</pre>
    <p class="hint" style="text-align:left">배포 커밋: ${esc(commit || '알 수 없음')}</p>
  </div>`}

  <div class="box warn">
    <h3>⚠️ 알아둘 것</h3>
    <ul>
      <li><b>인스턴스를 껐다 켜면 퍼블릭 IP와 터널 주소가 모두 바뀝니다.</b>
          새 IP로 <code>npm run access -- &lt;IP&gt;</code> 를 돌리면 이 파일이 갱신됩니다.</li>
      <li>주소가 바뀌면 브라우저 기준 다른 사이트라, <b>폰에서 알림 권한을 한 번 다시
          허용</b>해야 응급 푸시를 받습니다. 그다음부터는 방문만 해도 자동으로 재등록됩니다.</li>
      <li>이 주소를 아는 사람은 누구나 접속할 수 있습니다. 공개된 곳에 올리지 마세요.</li>
      <li>인스턴스를 끄면 <code>npm run access -- --stopped</code> 로 표시해 두면
          옛 주소로 헤매지 않습니다.</li>
    </ul>
  </div>
</div>

<!-- QR은 브라우저에서 그린다 — 주소가 외부 서비스로 나가지 않는다.
     인터넷이 없으면 QR만 안 그려지고 위의 링크 텍스트는 그대로 쓸 수 있다. -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
  document.querySelectorAll('.qr').forEach((el) => {
    if (typeof QRCode === 'undefined') return;
    new QRCode(el, { text: el.dataset.url, width: 176, height: 176 });
  });
</script>
<!-- hyodol-state: ${state} -->
</body>
</html>
`;
}

async function main() {
  const arg = process.argv[2];
  const prev = readState();

  if (arg === '--stopped' || arg === '--off') {
    fs.writeFileSync(OUT, render({ ip: prev?.ip, stopped: true }));
    console.log(`✅ ${path.basename(OUT)} — 중지됨으로 표시했습니다.`);
    return;
  }

  const ip = arg || prev?.ip;
  if (!ip) {
    console.error('퍼블릭 IP가 필요합니다.\n  사용법: npm run access -- <퍼블릭 IP>');
    process.exit(1);
  }
  if (!arg) console.log(`IP를 생략하셔서 이전 값(${ip})을 씁니다.`);

  if (!fs.existsSync(SSH_KEY)) {
    console.error(`SSH 키를 찾을 수 없습니다: ${SSH_KEY}`);
    console.error('HYODOL_SSH_KEY 환경변수로 경로를 지정할 수 있습니다.');
    process.exit(1);
  }

  let info;
  try {
    console.log(`${ip} 에 접속해 터널 주소를 읽는 중...`);
    info = fetchFromInstance(ip);
  } catch (err) {
    // 기존 파일을 덮어쓰지 않는다 — 실패했다고 멀쩡한 주소를 날리면 안 된다.
    console.error(`\n❌ SSH 접속 실패: ${ip}`);
    console.error('  · 인스턴스가 실행 중인지, IP가 맞는지 확인하세요 (껐다 켜면 IP가 바뀝니다)');
    console.error('  · 보안 그룹 인바운드 22번이 지금 있는 곳의 IP를 허용하는지 확인하세요');
    console.error(`  · 원본 오류: ${(err.stderr || err.message || '').toString().trim().split('\n').pop()}`);
    console.error(`\n기존 ${path.basename(OUT)} 은 그대로 두었습니다.`);
    process.exit(1);
  }

  if (!info.tunnel) {
    console.error('\n❌ 터널 주소를 찾지 못했습니다. cloudflared가 아직 안 떴을 수 있습니다.');
    console.error('  sudo systemctl status cloudflared.service 로 확인해 보세요.');
    process.exit(1);
  }

  const health = await checkHealth(info.tunnel);
  fs.writeFileSync(OUT, render({ ip, ...info, health }));

  console.log(`\n✅ ${path.basename(OUT)} 갱신 완료`);
  console.log(`   📺 라즈베리파이 : ${info.tunnel}/`);
  console.log(`   📱 휴대전화     : ${info.tunnel}/guardian`);
  console.log(`   상태: 백엔드 ${info.hyodol} / 터널 ${info.cloudflared} / 헬스체크 ${health}`);
  if (health !== 'ok') {
    console.log('\n⚠️  헬스체크가 통과하지 못했습니다. 주소는 적어 뒀지만 실제로 안 열릴 수 있습니다.');
  }
}

main().catch((err) => {
  console.error('예기치 못한 오류:', err.stack || err);
  process.exit(1);
});
