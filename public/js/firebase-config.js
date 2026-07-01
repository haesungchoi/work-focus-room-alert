// Firebase 콘솔 > 프로젝트 설정 > 일반 > "내 앱"(웹 앱)에서 나오는 값을 그대로 채워넣으세요.
// 이 값들은 비밀값이 아니라 클라이언트에 그대로 노출되는 공개 설정입니다 (실제 접근 제어는 firestore.rules / Cloud Functions에서 처리).
var FIREBASE_CONFIG = {
  apiKey: 'AIzaSyASL-Hj056975rwpnwLFVjeGb8PfByjaS0',
  authDomain: 'focus-room-alert.firebaseapp.com',
  projectId: 'focus-room-alert',
  storageBucket: 'focus-room-alert.firebasestorage.app',
  messagingSenderId: '805157222794',
  appId: '1:805157222794:web:c832aa1a1373d0f1be7073',
};

// Firebase 콘솔 > 프로젝트 설정 > 클라우드 메시징 > 웹 구성 > "웹 푸시 인증서" 에서 생성한 VAPID 공개 키.
var FIREBASE_VAPID_KEY = 'BDjkaxewiWyo0xIn0RRKg7xxHrs1fx6DhlFFpH9wDUcJyNR6GRI__wzqsgoJ09-lB6uMC3GjPRHXPzdr2lQCVwc';
