import React, { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import * as faceapi from 'face-api.js';

const FaceAnalyzer = forwardRef(({ 
  active, 
  setRecommendations, 
  setLoading, 
  userEmotion, 
  trait, 
  nostalgiaOn,
  onResultMeta   // ✅ 추가: App.jsx로 감정/나이/성별 전달
}, ref) => {
  const videoRef = useRef(null);
  const [analysis, setAnalysis] = useState('카메라 준비 중…');
  const [lastFace, setLastFace] = useState(null);
  const [ready, setReady] = useState(false);

  const loadModels = async () => {
    await faceapi.nets.ssdMobilenetv1.loadFromUri('/models');
    await faceapi.nets.faceExpressionNet.loadFromUri('/models');
    await faceapi.nets.ageGenderNet.loadFromUri('/models');
  };

  const startVideo = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: {} });
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await new Promise((resolve) => {
        videoRef.current.onloadedmetadata = () => {
          videoRef.current.play().then(resolve);
        };
      });
    }
  };

  const analyzeFace = async () => {
    const det = await faceapi
      .detectSingleFace(videoRef.current, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4 }))
      .withFaceExpressions()
      .withAgeAndGender();

    if (!det) {
      setAnalysis('얼굴을 찾지 못했습니다.');
      return null;
    }

    const { age, gender, expressions } = det;
    const dominantExpression = Object.entries(expressions).reduce((a, b) => (a[1] > b[1] ? a : b))[0];
    const genderKo = gender === 'male' ? '남자' : '여자';
    setAnalysis(`성별: ${genderKo}, 나이(예상): ${Math.round(age)}, 감정: ${dominantExpression}`);

    const faceInfo = {
      age: Math.round(age),
      gender,
      emotion: dominantExpression,
      faceDist: expressions,
      quality: 0.8
    };

    setLastFace(faceInfo);
    return faceInfo;
  };

  const getRecommendations = async () => {
    if (!ready) {
      console.warn('카메라 준비가 아직 안됨');
      return;
    }

    setLoading?.(true);
    let faceInfo = await analyzeFace();
    if (!faceInfo) faceInfo = lastFace;

    try {
      const res = await fetch('http://localhost:5000/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          age: faceInfo?.age ?? 0,
          gender: faceInfo?.gender ?? "unknown",
          emotion: faceInfo?.emotion ?? userEmotion ?? "neutral",
          nostalgia: !!nostalgiaOn
        })
      });
      const data = await res.json();

      // ✅ 추천 목록 상태 업데이트
      setRecommendations(Array.isArray(data.recommendations) ? data.recommendations : []);

      // ✅ 감정/나이/성별을 App.jsx로 전달
      if (onResultMeta) {
        onResultMeta({
          emotion: data.emotion || faceInfo?.emotion || 'neutral',
          age: faceInfo?.age ?? null,
          gender: faceInfo?.gender ?? null
        });
      }

    } catch (err) {
      console.error(err);
      setRecommendations([]);
    } finally {
      setLoading?.(false);
    }
  };

  useImperativeHandle(ref, () => ({
    requestRecommendations: getRecommendations
  }));

  useEffect(() => {
    if (!active) return;
    (async () => {
      try {
        await loadModels();
        await startVideo();
        setReady(true);
      } catch (e) {
        console.error(e);
        setAnalysis('카메라/모델 로드 실패');
      }
    })();
  }, [active]); 

  return (
    <div>
      {active ? (
        <>
          <video ref={videoRef} autoPlay muted width="400" height="300" />
          <p>{analysis}</p>
        </>
      ) : (
        <p>카메라 준비 전 (버튼을 눌러 시작하세요)</p>
      )}
    </div>
  );
});

export default FaceAnalyzer;
