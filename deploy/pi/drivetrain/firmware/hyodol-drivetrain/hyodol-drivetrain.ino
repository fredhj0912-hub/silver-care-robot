/**
 * 우노 펌웨어 재작성 (2026-09-04).
 *
 * 원본 스케치(.ino)를 구할 수 없어(동아리방에서 굴러다니던 보드, 작성자 불명) 플래시를
 * 덤프해 프로토콜만 알아내고(docs/pi-runbook.md §9) 새로 짰다. 덤프 자체는
 * 파이의 ~/firmware-backup/original-2026-09-04.bin 에 있다 — 되돌릴 일이 있으면
 *   avrdude -c arduino -p m328p -P /dev/ttyUSB0 -b 115200 -U flash:w:original-2026-09-04.bin:r
 *
 * 프로토콜은 원본과 그대로 맞췄다 — 115200bps, 한 글자: F(전진) B(후진) L(좌회전)
 * R(우회전) S(정지). deploy/pi/drivetrain/motors.py 는 고칠 필요가 없다.
 *
 * 원본과 다르게 고친 것 둘 (TODO.md의 "펌웨어가 반복 명령을 못 받는다" 항목):
 *   1) **멱등이다.** 같은 글자를 몇 번 받아도 상태를 다시 적용할 뿐 토글되지 않는다.
 *      원본은 같은 글자를 두 번 받으면 멈췄다(2026-09-03 실물 확인) — motors.py가
 *      "의도가 바뀔 때 한 글자만" 보내는 것은 그 버그를 피하기 위한 임시방편이었다.
 *      이 펌웨어에는 필요 없지만, 계속 그렇게 보내도 무해하다(레벨 기반이라 반복 수신 시
 *      같은 값을 다시 적용할 뿐이다).
 *   2) **자체 타임아웃이 있다.** WATCHDOG_MS 동안 새 명령이 없으면 스스로 멈춘다.
 *      원래는 drivetrain.py 프로세스가 죽으면(SIGKILL·전원 문제) 아무도 못 멈췄다
 *      (README "아직 못 미더운 것" 1번). 이제 우노가 마지막 방어선이다.
 *
 * 배선 (2026-09-04 실사로 확인):
 *   D4 DIR1 · D5 PWM1 · D6 DIR2 · D7 PWM2 · GND 공통 — Cytron MDD10A, 왼쪽/오른쪽 채널.
 *   이 배정은 커넥터에 인쇄된 글자를 직접 읽은 게 아니라 Cytron 제품군의 통상 순서
 *   (DIR1,PWM1,DIR2,PWM2)를 따른 추정이다. **방향이 반대로 나오면 아래
 *   LEFT_FORWARD/RIGHT_FORWARD 상수만 뒤집는다 — 배선은 바꾸지 않는다.**
 */

const uint8_t DIR1 = 4, PWM1 = 5, DIR2 = 6, PWM2 = 7;

// 방향이 반대면 이 둘만 뒤집는다.
const uint8_t LEFT_FORWARD = HIGH;
const uint8_t RIGHT_FORWARD = HIGH;

// 잠정 속도(0~255). 원본에는 속도 개념이 아예 없었다 — 안전하게 낮게 잡았다.
// AA 배터리팩이라 전압이 처지면(TODO.md 참고) 더 낮출 수 있다. 바닥 실주행으로 다시 잰다.
const uint8_t MOTOR_PWM = 120;

// 이만큼 새 명령이 없으면 스스로 멈춘다. drivetrain.py의 폴링 주기(200ms)보다
// 넉넉히 위여야 정상 동작 중 오탐으로 멈추지 않는다.
const unsigned long WATCHDOG_MS = 500;

char currentCmd = 'S';
unsigned long lastCmdAt = 0;

void applyStop() {
  analogWrite(PWM1, 0);
  analogWrite(PWM2, 0);
}

void applyCommand(char cmd) {
  switch (cmd) {
    case 'F':
      digitalWrite(DIR1, LEFT_FORWARD);
      digitalWrite(DIR2, RIGHT_FORWARD);
      analogWrite(PWM1, MOTOR_PWM);
      analogWrite(PWM2, MOTOR_PWM);
      break;
    case 'B':
      digitalWrite(DIR1, !LEFT_FORWARD);
      digitalWrite(DIR2, !RIGHT_FORWARD);
      analogWrite(PWM1, MOTOR_PWM);
      analogWrite(PWM2, MOTOR_PWM);
      break;
    case 'L': // 제자리 회전(스핀) — 왼쪽 후진, 오른쪽 전진
      digitalWrite(DIR1, !LEFT_FORWARD);
      digitalWrite(DIR2, RIGHT_FORWARD);
      analogWrite(PWM1, MOTOR_PWM);
      analogWrite(PWM2, MOTOR_PWM);
      break;
    case 'R': // 제자리 회전(스핀) — 왼쪽 전진, 오른쪽 후진
      digitalWrite(DIR1, LEFT_FORWARD);
      digitalWrite(DIR2, !RIGHT_FORWARD);
      analogWrite(PWM1, MOTOR_PWM);
      analogWrite(PWM2, MOTOR_PWM);
      break;
    case 'S':
    default:
      applyStop();
      break;
  }
}

void setup() {
  pinMode(DIR1, OUTPUT);
  pinMode(PWM1, OUTPUT);
  pinMode(DIR2, OUTPUT);
  pinMode(PWM2, OUTPUT);
  applyStop(); // 켜지는 순간부터 정지가 기본값이다
  Serial.begin(115200);
  lastCmdAt = millis();
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'F' || c == 'B' || c == 'L' || c == 'R' || c == 'S') {
      currentCmd = c;
      lastCmdAt = millis();
      applyCommand(currentCmd); // 매번 다시 적용한다 — 레벨 기반이라 반복 수신에 안전하다
    }
    // 모르는 글자는 무시한다(정지시키지 않는다) — 노이즈 한 글자로 서게 만들 이유가 없다.
    // 안전은 아래 워치독이 담당한다.
  }

  // 워치독: 명령이 끊기면 스스로 멈춘다. drivetrain.py 프로세스가 죽어도 마지막 방어선.
  if (currentCmd != 'S' && millis() - lastCmdAt > WATCHDOG_MS) {
    currentCmd = 'S';
    applyStop();
  }
}
