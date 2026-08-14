<template>
  <div class="scanner">
    <header class="header">
      <button @click="goBack" class="btn-back">← Back</button>
      <h1>Scan Ticket</h1>
      <div class="spacer"></div>
    </header>

    <div class="container">
      <div v-if="!cameraActive" class="camera-prompt">
        <p>Click the button below to activate your camera and scan QR codes</p>
        <button @click="startCamera" class="btn-camera">
          📷 Activate Camera
        </button>
      </div>

      <div v-if="cameraActive" class="camera-modal">
        <div class="camera-modal-content">
          <div class="camera-container" :class="{ 'scan-success': scanFlash }">
            <video ref="videoElement" autoplay playsinline></video>
            <div class="scanner-overlay">
              <div class="scanner-box"></div>
            </div>
          </div>
          
          <p class="camera-hint">Position QR code within the frame</p>
          <button @click="stopCamera" class="btn-stop">Close Camera</button>
        </div>
        
        <!-- Show verification result overlay above camera -->
        <div v-if="verificationResult" class="result-overlay">
          <div class="result-card" :class="resultClass">
            <div class="result-icon">{{ resultIcon }}</div>
            <h2>{{ resultTitle }}</h2>
            
            <div v-if="ticketData" class="ticket-details">
              <div class="detail-row">
                <span class="label">Name:</span>
                <span class="value">{{ ticketData.name }}</span>
              </div>
              <div v-if="ticketData.eventName" class="detail-row">
                <span class="label">Event:</span>
                <span class="value badge">{{ ticketData.eventName }}</span>
              </div>
              <div v-if="ticketData.eventDate" class="detail-row">
                <span class="label">Date:</span>
                <span class="value">{{ ticketData.eventDate }}</span>
              </div>
              <div v-if="ticketData.location" class="detail-row">
                <span class="label">Location:</span>
                <span class="value">{{ ticketData.location }}</span>
              </div>
            </div>

            <p v-if="resultMessage" class="result-message">{{ resultMessage }}</p>

            <button @click="resetScanner" class="btn-reset">
              Scan Another Ticket
            </button>
          </div>
        </div>
        
        <!-- Error popup for already used / wrong day -->
        <div v-if="showErrorPopup" class="error-popup" :class="errorPopupType">
          <div class="error-popup-content">
            <div class="error-popup-icon">{{ errorPopupIcon }}</div>
            <p class="error-popup-message">{{ errorPopupMessage }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import axios from 'axios';
import jsQR from 'jsqr';

export default {
  name: 'Scanner',
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();

    const videoElement = ref(null);
    const cameraActive = ref(false);
    const verificationResult = ref(null);
    const ticketData = ref(null);
    const error = ref('');
    const stream = ref(null);
    const animationFrame = ref(null);
    const scanFlash = ref(false);

    const resultClass = ref('');
    const resultIcon = ref('');
    const resultTitle = ref('');
    const resultMessage = ref('');
    
    const showErrorPopup = ref(false);
    const errorPopupMessage = ref('');
    const errorPopupIcon = ref('');
    const errorPopupType = ref('');
    const isScanning = ref(false); // Lock to prevent multiple scans

    const startCamera = async () => {
      try {
        error.value = '';
        console.log('Starting camera...');
        
        // Check if mediaDevices is available
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          error.value = 'Camera API not supported. Please use HTTPS or a modern browser.';
          return;
        }

        // iOS-friendly constraints
        const constraints = {
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        };

        console.log('Requesting camera access...');
        stream.value = await navigator.mediaDevices.getUserMedia(constraints);
        console.log('Camera stream obtained:', stream.value);
        
        // Set camera active first so the video element gets rendered
        cameraActive.value = true;
        
        // Wait for next tick to ensure video element is in DOM
        await new Promise(resolve => setTimeout(resolve, 100));
        
        console.log('Video element ref:', videoElement.value);
        
        if (videoElement.value) {
          videoElement.value.srcObject = stream.value;
          console.log('Camera activated, video element set');
          
          // Wait for video to be ready before scanning
          videoElement.value.onloadedmetadata = () => {
            console.log('Video metadata loaded, starting playback');
            videoElement.value.play();
            scanQRCode();
          };
        } else {
          console.error('Video element not found in DOM!');
          error.value = 'Unable to initialize video element. Please try again.';
        }
      } catch (err) {
        console.error('Camera error:', err);
        
        // Provide specific error messages
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          error.value = '❌ Camera access denied. Please enable camera permissions in your browser settings.';
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          error.value = '❌ No camera found on this device.';
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
          error.value = '❌ Camera is already in use by another app. Please close other apps and try again.';
        } else if (err.name === 'OverconstrainedError') {
          error.value = '❌ Camera constraints not supported. Trying alternative...';
          // Retry with simpler constraints
          retryWithBasicConstraints();
        } else if (err.name === 'NotSupportedError') {
          error.value = '⚠️ Camera access requires HTTPS. Please access this app via https:// instead of http://';
        } else if (err.name === 'TypeError') {
          error.value = '⚠️ Camera access requires HTTPS connection. This app must be accessed via https:// on iOS devices.';
        } else {
          error.value = `❌ Unable to access camera: ${err.message || 'Unknown error'}. On iOS, this app requires HTTPS.`;
        }
      }
    };

    const retryWithBasicConstraints = async () => {
      try {
        stream.value = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });
        
        if (videoElement.value) {
          videoElement.value.srcObject = stream.value;
          cameraActive.value = true;
          videoElement.value.onloadedmetadata = () => {
            videoElement.value.play();
            scanQRCode();
          };
          error.value = '';
        }
      } catch (retryErr) {
        console.error('Retry failed:', retryErr);
        error.value = '❌ Camera access failed. Please check browser permissions and ensure you are using HTTPS.';
      }
    };

    const stopCamera = () => {
      if (stream.value) {
        stream.value.getTracks().forEach(track => track.stop());
        stream.value = null;
      }
      if (animationFrame.value) {
        cancelAnimationFrame(animationFrame.value);
      }
      cameraActive.value = false;
    };

    const scanQRCode = () => {
      if (!cameraActive.value || !videoElement.value) return;

      const video = videoElement.value;
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');

      const scan = () => {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          
          const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height);

          if (code) {
            handleQRCode(code.data);
            return;
          }
        }

        animationFrame.value = requestAnimationFrame(scan);
      };

      scan();
    };

    const handleQRCode = async (data) => {
      // Prevent multiple scans while processing
      if (isScanning.value) {
        console.log('Scan already in progress, ignoring QR code');
        return;
      }

      isScanning.value = true;
      
      // Trigger green flash animation
      scanFlash.value = true;
      setTimeout(() => {
        scanFlash.value = false;
      }, 500);

      // Pause scanning while verifying (but keep camera running)
      if (animationFrame.value) {
        cancelAnimationFrame(animationFrame.value);
      }
      
      // Extract UUID from QR code data
      // Handle two formats:
      // 1. Full URL: http://domain/verify/UUID
      // 2. Raw UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      let uuid;
      
      const urlMatch = data.match(/\/verify\/([a-f0-9-]+)/i);
      if (urlMatch) {
        uuid = urlMatch[1];
      } else {
        // Check if it's a raw UUID format
        const uuidRegex = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
        if (uuidRegex.test(data.trim())) {
          uuid = data.trim();
        }
      }
      
      if (!uuid) {
        console.error('Invalid QR code format:', data);
        // Show error popup for invalid QR
        showErrorPopupNotification('✕', 'Invalid QR Code Format', 'error');
        return;
      }

      await verifyTicket(uuid);
    };

    const verifyTicket = async (uuid) => {
      try {
        const response = await axios.get(`/api/verify/${uuid}`);
        const result = response.data;

        console.log('Verification result:', result);

        verificationResult.value = result.status;
        ticketData.value = result;
        
        console.log('Ticket data:', ticketData.value);
        console.log('Supplies:', ticketData.value.supplies);

        if (result.status === 'valid') {
          resultClass.value = 'success';
          resultIcon.value = '✓';
          resultTitle.value = 'Access Granted!';
          resultMessage.value = result.message || 'Issue wristband for re-entry';
        } else {
          resultClass.value = 'error';
          resultIcon.value = '✕';
          resultTitle.value = 'Invalid Ticket';
          resultMessage.value = result.message || 'This ticket is not valid';
        }
      } catch (err) {
        console.error('Verification error:', err);
        
        // Check if error response has data (backend returns 400/404 with error details)
        if (err.response && err.response.data) {
          const result = err.response.data;
          console.log('Error response data:', result);
          
          // Show result overlay for already scanned and wrong date (require manual dismiss)
          if (result.status === 'already_used' || result.status === 'already_scanned_today' || result.status === 'already_scanned') {
            console.log('Showing already scanned result');
            verificationResult.value = result.status;
            ticketData.value = result;
            resultClass.value = 'warning';
            resultIcon.value = '⚠️';
            resultTitle.value = 'Already Scanned';
            resultMessage.value = result.message || 'Already Scanned - Check Wristband';
            return;
          } else if (result.status === 'wrong_date') {
            console.log('Showing wrong date result');
            verificationResult.value = result.status;
            ticketData.value = result;
            resultClass.value = 'error';
            resultIcon.value = '✕';
            resultTitle.value = 'Wrong Date';
            resultMessage.value = result.message || 'Wrong Date - Not Valid Today';
            return;
          } else if (result.status === 'invalid') {
            // Invalid tickets use auto-dismiss popup
            showErrorPopupNotification('✕', result.message || 'Invalid Ticket', 'error');
            return;
          }
        }
        
        // Generic error - auto-dismiss popup
        showErrorPopupNotification('✕', 'Failed to Verify Ticket', 'error');
      }
    };

    const showErrorPopupNotification = (icon, message, type) => {
      console.log('showErrorPopupNotification called:', { icon, message, type });
      errorPopupIcon.value = icon;
      errorPopupMessage.value = message;
      errorPopupType.value = type;
      showErrorPopup.value = true;
      
      console.log('Error popup state:', showErrorPopup.value);
      
      // Auto-hide after 2 seconds and resume scanning
      setTimeout(() => {
        console.log('Hiding error popup and resuming scan');
        showErrorPopup.value = false;
        isScanning.value = false; // Release scanning lock
        // Resume scanning after popup closes
        if (cameraActive.value && !verificationResult.value) {
          scanQRCode();
        }
      }, 2000);
    };

    const resetScanner = () => {
      verificationResult.value = null;
      ticketData.value = null;
      resultClass.value = '';
      resultIcon.value = '';
      resultTitle.value = '';
      resultMessage.value = '';
      scanFlash.value = false;
      isScanning.value = false; // Release scanning lock
      
      // Resume scanning
      if (cameraActive.value) {
        scanQRCode();
      }
    };

    const goBack = () => {
      stopCamera();
      router.push('/');
    };

    onMounted(() => {
      authStore.initAuth();
    });

    onUnmounted(() => {
      stopCamera();
    });

    return {
      videoElement,
      cameraActive,
      verificationResult,
      ticketData,
      error,
      resultClass,
      resultIcon,
      resultTitle,
      resultMessage,
      scanFlash,
      showErrorPopup,
      errorPopupMessage,
      errorPopupIcon,
      errorPopupType,
      startCamera,
      stopCamera,
      resetScanner,
      goBack,
      retryWithBasicConstraints,
    };
  },
};
</script>

<style scoped>
.scanner {
  min-height: 100vh;
  background: #f5f5f5;
}

.header {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 15px 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header h1 {
  margin: 0;
  font-size: 20px;
}

.btn-back {
  background: rgba(255, 255, 255, 0.2);
  color: white;
  border: none;
  padding: 8px 15px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
}

.spacer {
  width: 70px;
}

.container {
  padding: 20px;
  max-width: 600px;
  margin: 0 auto;
  position: relative;
  min-height: calc(100vh - 80px);
}

.camera-prompt {
  text-align: center;
  padding: 40px 20px;
  background: white;
  border-radius: 15px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  max-width: 500px;
  margin: 0 auto;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 90%;
}

.camera-prompt p {
  color: #666;
  margin-bottom: 30px;
  font-size: 16px;
}

.btn-camera {
  padding: 15px 30px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  border-radius: 10px;
  font-size: 18px;
  cursor: pointer;
  box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
  transition: transform 0.2s;
}

.btn-camera:hover {
  transform: scale(1.05);
}

.btn-camera:active {
  transform: scale(0.98);
}

.camera-modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.9);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 10px;
}

.camera-modal-content {
  width: 100%;
  max-width: 500px;
  text-align: center;
  display: flex;
  flex-direction: column;
  max-height: 100vh;
}

.camera-view {
  text-align: center;
}

.camera-container {
  position: relative;
  background: black;
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 12px;
  border: 5px solid transparent;
  transition: border-color 0.3s ease;
  max-height: 60vh;
}

.camera-container.scan-success {
  border-color: #4CAF50;
  animation: flashGreen 0.5s ease;
}

@keyframes flashGreen {
  0%, 100% {
    border-color: transparent;
    box-shadow: none;
  }
  50% {
    border-color: #4CAF50;
    box-shadow: 0 0 30px rgba(76, 175, 80, 0.8);
  }
}

video {
  width: 100%;
  height: auto;
  max-height: 60vh;
  display: block;
  background: #000;
  object-fit: cover;
}

.scanner-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.scanner-box {
  width: 200px;
  height: 200px;
  border: 3px solid #4CAF50;
  border-radius: 10px;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
}

.camera-hint {
  color: #fff;
  margin-bottom: 10px;
  font-size: 13px;
}

.btn-stop {
  padding: 10px 24px;
  background: #f44336;
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 15px;
  transition: background 0.2s;
}

.btn-stop:hover {
  background: #d32f2f;
}

.result-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  padding: 20px;
  overflow-y: auto;
}

.result-card {
  background: white;
  border-radius: 15px;
  padding: 24px;
  text-align: center;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  max-width: 450px;
  width: 100%;
  margin: auto;
}

.result-card.success {
  border-top: 5px solid #4CAF50;
}

.result-card.warning {
  border-top: 5px solid #FF9800;
}

.result-card.error {
  border-top: 5px solid #f44336;
}

.result-icon {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
  margin: 0 auto 15px;
  color: white;
  font-weight: bold;
}

.result-card.success .result-icon {
  background: #4CAF50;
}

.result-card.warning .result-icon {
  background: #FF9800;
}

.result-card.error .result-icon {
  background: #f44336;
}

.result-card h2 {
  margin: 0 0 10px 0;
  color: #333;
  font-size: 20px;
}

.result-message {
  color: #666;
  margin: 10px 0 20px 0;
  font-size: 14px;
}

.ticket-details {
  text-align: left;
  margin: 30px 0;
  padding: 20px;
  background: #f8f9fa;
  border-radius: 10px;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid #e0e0e0;
}

.detail-row:last-child {
  border-bottom: none;
}

.label {
  font-weight: 600;
  color: #666;
}

.value {
  color: #333;
}

.badge {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

.badge.student {
  background: #e8f5e9;
  color: #2e7d32;
}

.badge.exhibitor {
  background: #fff3e0;
  color: #e65100;
}

.badge.day_pass {
  background: #e3f2fd;
  color: #1565c0;
}

.supplies-section {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 2px solid #e0e0e0;
}

.supplies-section h3 {
  margin: 0 0 15px 0;
  color: #333;
  font-size: 16px;
}

.supplies-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.supplies-list li {
  display: flex;
  justify-content: space-between;
  padding: 10px;
  background: white;
  border-radius: 5px;
  margin-bottom: 8px;
}

.supply-name {
  color: #333;
}

.supply-qty {
  font-weight: 600;
  color: #667eea;
}

.btn-reset {
  width: 100%;
  padding: 15px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  border-radius: 10px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
}

.error-card {
  background: white;
  border-radius: 15px;
  padding: 30px;
  text-align: center;
  border-top: 5px solid #f44336;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  margin-top: 20px;
}

.error-card p {
  color: #f44336;
  margin-bottom: 15px;
  font-size: 14px;
}

.btn-retry {
  padding: 12px 30px;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 16px;
}

.error-popup {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2000;
  animation: slideDown 0.3s ease;
}

@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(-20px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

.error-popup-content {
  background: white;
  padding: 20px 30px;
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  gap: 15px;
  min-width: 280px;
  max-width: 90vw;
}

.error-popup.warning .error-popup-content {
  border-left: 5px solid #FF9800;
}

.error-popup.error .error-popup-content {
  border-left: 5px solid #f44336;
}

.error-popup-icon {
  font-size: 32px;
  line-height: 1;
}

.error-popup.warning .error-popup-icon {
  color: #FF9800;
}

.error-popup.error .error-popup-icon {
  color: #f44336;
}

.error-popup-message {
  margin: 0;
  color: #333;
  font-size: 16px;
  font-weight: 600;
}
</style>
