import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api';

/**
 * 카메라로 주기적으로 프레임을 찍어 /api/vision 에 보낸다.
 *
 * 이전에는 백엔드에 완성된 비전 파이프라인(Gemini Vision + 낙상 판정)이 있었지만
 * 프론트엔드가 /api/vision 을 한 번도 호출하지 않아 도달 불가능한 코드였다.
 *
 * 기본은 비활성 — 카메라를 켜는 건 사용자 동의와 비용이 함께 따르는 일이라
 * 명시적으로 켜야 한다(VITE_VISION_ENABLED=true).
 */
export function useCameraMonitor({ enabled, intervalMs = 15000, onEmergency }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraError, setCameraError] = useState(null);
  const [lastCaptureAt, setLastCaptureAt] = useState(null);

  // effect는 enabled/intervalMs가 바뀔 때만 재시작한다.
  // onEmergency를 매번 최신값으로 부르기 위해 ref로 감싼다 (stale closure 방지).
  const onEmergencyRef = useRef(onEmergency);
  useEffect(() => { onEmergencyRef.current = onEmergency; }, [onEmergency]);

  useEffect(() => {
    if (!enabled) return undefined;

    let stopped = false;
    let timer = null;

    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        scheduleCapture();
      } catch (err) {
        // 카메라가 없거나 권한이 거부된 경우 — 로봇 대화 기능은 이것 없이도 정상 동작해야 한다
        setCameraError(err.message);
        console.warn('카메라를 시작하지 못했습니다 (음성 대화는 정상 동작합니다):', err.message);
      }
    }

    function scheduleCapture() {
      timer = setTimeout(async () => {
        await captureAndSend();
        if (!stopped) scheduleCapture();
      }, intervalMs);
    }

    async function captureAndSend() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) return;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);

      const dataUri = canvas.toDataURL('image/jpeg', 0.7);

      try {
        const res = await apiFetch('/api/vision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUri }),
        });
        if (res.ok) {
          const data = await res.json();
          setLastCaptureAt(new Date().toISOString());
          if (data.isEmergency) onEmergencyRef.current?.(data);
        }
      } catch (err) {
        console.warn('카메라 프레임 전송 실패:', err.message);
      }
    }

    startCamera();

    return () => {
      stopped = true;
      clearTimeout(timer);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [enabled, intervalMs]);

  return { videoRef, canvasRef, cameraError, lastCaptureAt };
}
