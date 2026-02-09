"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Mic, Volume2, VolumeX, Loader2, Camera } from "lucide-react";
import {
  VoiceActivityDetector,
  VoiceActivityEvent,
} from "@/lib/voice-activity-detector";

const WAVE_BARS = 20;
const WAVE_MAX_HEIGHT = 60;
const WAVE_MIN_HEIGHT = 4;
const CAPTURE_WINDOW_SECONDS = 5;

type AnalysisMode = "idle" | "continuous" | "single";

interface Recording {
  timestamp: string;
  size: number;
  analysis?: string;
  processingTime?: number;
  transcription?: string;
}

interface GeminiResponse {
  mode: AnalysisMode;
  reason: string;
  shouldRespond: boolean;
  transcription?: string;
  speak: string;
}

export default function ImprovedIntelligentAnalyzer() {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTimer, setRecordingTimer] = useState(0);
  const [cameraReady, setCameraReady] = useState(false);
  const [audioLevels, setAudioLevels] = useState(
    Array(WAVE_BARS).fill(WAVE_MIN_HEIGHT),
  );
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [currentAnalysis, setCurrentAnalysis] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  const [hasPermissions, setHasPermissions] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [currentMode, setCurrentMode] = useState<AnalysisMode>("idle");
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [speechConfidence, setSpeechConfidence] = useState(0);
  const [lastTranscription, setLastTranscription] = useState<string>("");
  const [isInitializing, setIsInitializing] = useState(false);
  const [audioBufferReady, setAudioBufferReady] = useState(false);
  const [videoBufferReady, setVideoBufferReady] = useState(false);
  const [sessionId, setSessionId] = useState(0);
  const [retryCount, setRetryCount] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderVideoRef = useRef<MediaRecorder | null>(null);
  const mediaRecorderAudioRef = useRef<MediaRecorder | null>(null);
  const videoChunksRef = useRef<Blob[]>([]);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const vadRef = useRef<VoiceActivityDetector | null>(null);
  const speechEndTimerRef = useRef<NodeJS.Timeout | null>(null);
  const continuousModeRef = useRef(false);
  const isSpeechEndingRef = useRef(false);
  const shouldSendRequestRef = useRef(false);
  const analysisInProgressRef = useRef(false);
  const lastAnalysisDataRef = useRef<{
    videoBlob: Blob | null;
    audioBlob: Blob | null;
    intent: string;
  } | null>(null);

  const currentModeRef = useRef<AnalysisMode>(currentMode);
  const isProcessingRef = useRef(isProcessing);
  const recordingSessionIdRef = useRef(0);

  useEffect(() => {
    currentModeRef.current = currentMode;
  }, [currentMode]);

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  // TTS Function
  const speakText = useCallback((text: string) => {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.9;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      utterance.lang = "en-US";

      utterance.onstart = () => setTtsSpeaking(true);
      utterance.onend = () => setTtsSpeaking(false);
      utterance.onerror = () => setTtsSpeaking(false);

      window.speechSynthesis.speak(utterance);
    }
  }, []);

  const stopTTS = useCallback(() => {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      setTtsSpeaking(false);
    }
  }, []);

  // Reset buffers
  const resetBuffers = useCallback(() => {
    console.log("🔄 Resetting buffers for new session");
    videoChunksRef.current = [];
    audioChunksRef.current = [];
    setAudioBufferReady(false);
    setVideoBufferReady(false);
    shouldSendRequestRef.current = false;
  }, []);

  // Stop all media recorders properly and wait for onstop
  const stopAllMediaRecorders = useCallback(() => {
    return new Promise<void>((resolve) => {
      console.log(
        "🛑 Stopping all media recorders with session ID:",
        recordingSessionIdRef.current,
      );

      let pending = 0;

      const done = () => {
        pending--;
        console.log(`✅ Recorder stopped, pending: ${pending}`);
        if (pending <= 0) {
          console.log("🎉 All recorders fully stopped");
          resolve();
        }
      };

      // Stop video recorder
      if (mediaRecorderVideoRef.current) {
        const recorder = mediaRecorderVideoRef.current;
        if (recorder.state !== "inactive") {
          pending++;
          console.log("🎥 Stopping video recorder...");
          recorder.onstop = done;
          recorder.stop();
        }
        mediaRecorderVideoRef.current = null;
      }

      // Stop audio recorder
      if (mediaRecorderAudioRef.current) {
        const recorder = mediaRecorderAudioRef.current;
        if (recorder.state !== "inactive") {
          pending++;
          console.log("🎤 Stopping audio recorder...");
          recorder.onstop = done;
          recorder.stop();
        }
        mediaRecorderAudioRef.current = null;
      }

      if (pending === 0) {
        console.log("✅ No active recorders to stop");
        resolve();
      }
    });
  }, []);

  // Start recording with fresh buffers and session ID
  const startRecordingInternal = useCallback(
    async (stream: MediaStream) => {
      console.log("=== Starting New Recording Session ===");

      // Increment session ID to invalidate old recorders
      const currentSessionId = ++recordingSessionIdRef.current;
      setSessionId(currentSessionId);
      console.log(`🆕 New session ID: ${currentSessionId}`);

      // Reset buffers for fresh start
      resetBuffers();

      // Get fresh tracks
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];

      if (!videoTrack || !audioTrack) {
        console.error("Missing video or audio track");
        return false;
      }

      let videoStarted = false;
      let audioStarted = false;

      // VIDEO RECORDER with session protection
      try {
        const videoStream = new MediaStream([videoTrack]);
        mediaRecorderVideoRef.current = new MediaRecorder(videoStream, {
          mimeType: "video/webm;codecs=vp9",
          videoBitsPerSecond: 500000,
        });

        mediaRecorderVideoRef.current.ondataavailable = (event) => {
          // CRITICAL: Ignore events from old sessions
          if (recordingSessionIdRef.current !== currentSessionId) {
            console.log(
              `⚠️ Ignoring video chunk from old session (current: ${recordingSessionIdRef.current}, chunk session: ${currentSessionId})`,
            );
            return;
          }

          if (event.data && event.data.size > 0) {
            console.log(
              `🎥 Video chunk added to session ${currentSessionId}: ${event.data.size} bytes`,
            );
            videoChunksRef.current.push(event.data);

            // Keep buffer size manageable
            if (videoChunksRef.current.length > 10) {
              videoChunksRef.current.shift();
            }

            // Mark buffer as ready after 2 chunks
            if (videoChunksRef.current.length >= 2 && !videoBufferReady) {
              setVideoBufferReady(true);
            }
          }
        };

        mediaRecorderVideoRef.current.onstop = () => {
          console.log(
            `🎥 Video recorder for session ${currentSessionId} stopped`,
          );
        };

        mediaRecorderVideoRef.current.start(1000);
        videoStarted = true;
        console.log(
          `🎥 Video recording started for session ${currentSessionId}`,
        );
      } catch (error) {
        console.error("Failed to start video recorder:", error);
      }

      // AUDIO RECORDER with session protection
      try {
        const audioStream = new MediaStream([audioTrack]);
        mediaRecorderAudioRef.current = new MediaRecorder(audioStream, {
          mimeType: "audio/webm;codecs=opus",
          audioBitsPerSecond: 128000,
        });

        mediaRecorderAudioRef.current.ondataavailable = (event) => {
          // CRITICAL: Ignore events from old sessions
          if (recordingSessionIdRef.current !== currentSessionId) {
            console.log(
              `⚠️ Ignoring audio chunk from old session (current: ${recordingSessionIdRef.current}, chunk session: ${currentSessionId})`,
            );
            return;
          }

          if (event.data && event.data.size > 0) {
            console.log(
              `🎤 Audio chunk added to session ${currentSessionId}: ${event.data.size} bytes`,
            );
            audioChunksRef.current.push(event.data);

            // Keep buffer size manageable
            if (audioChunksRef.current.length > 10) {
              audioChunksRef.current.shift();
            }

            // Mark buffer as ready after 2 chunks
            if (audioChunksRef.current.length >= 2 && !audioBufferReady) {
              setAudioBufferReady(true);
            }
          }
        };

        mediaRecorderAudioRef.current.onstop = () => {
          console.log(
            `🎤 Audio recorder for session ${currentSessionId} stopped`,
          );
        };

        mediaRecorderAudioRef.current.start(1000);
        audioStarted = true;
        console.log(
          `🎤 Audio recording started for session ${currentSessionId}`,
        );
      } catch (error) {
        console.error("Failed to start audio recorder:", error);
      }

      if (videoStarted || audioStarted) {
        setIsRecording(true);
        setRecordingTimer(0);
        console.log(
          `✅ Recording session ${currentSessionId} started successfully`,
        );
        console.log(
          `Initial buffers: Video=${videoChunksRef.current.length}, Audio=${audioChunksRef.current.length}`,
        );
        return true;
      }

      return false;
    },
    [resetBuffers, videoBufferReady, audioBufferReady],
  );

  // Send data to Gemini API with retry logic
  const analyzeWithGemini = useCallback(
    async (
      intent?: string,
      isRetry: boolean = false,
    ): Promise<GeminiResponse | null> => {
      if (analysisInProgressRef.current) {
        console.log("⚠️ Analysis already in progress, skipping...");
        return null;
      }

      analysisInProgressRef.current = true;
      setIsProcessing(true);
      const startTime = Date.now();

      try {
        console.log(
          `📤 [Session ${recordingSessionIdRef.current}] Sending to Gemini API... (Retry: ${retryCount}/3)`,
        );
        console.log("Video chunks:", videoChunksRef.current.length);
        console.log("Audio chunks:", audioChunksRef.current.length);

        if (
          videoChunksRef.current.length === 0 &&
          audioChunksRef.current.length === 0
        ) {
          console.error("❌ No data to analyze!");
          const errorMsg = "No audio or video recorded. Please speak again.";
          setCurrentAnalysis(errorMsg);
          speakText(errorMsg);
          return null;
        }

        let videoBlob: Blob | null = null;
        let audioBlob: Blob | null = null;

        if (videoChunksRef.current.length > 0) {
          videoBlob = new Blob(videoChunksRef.current, {
            type: "video/webm;codecs=vp9",
          });
          console.log(
            `📹 Video size: ${(videoBlob.size / 1024).toFixed(2)} KB (${videoChunksRef.current.length} chunks)`,
          );
        }

        if (audioChunksRef.current.length > 0) {
          audioBlob = new Blob(audioChunksRef.current, {
            type: "audio/webm;codecs=opus",
          });
          console.log(
            `🎤 Audio size: ${(audioBlob.size / 1024).toFixed(2)} KB (${audioChunksRef.current.length} chunks)`,
          );
        }

        // Store data for potential retry
        if (!isRetry) {
          lastAnalysisDataRef.current = {
            videoBlob,
            audioBlob,
            intent: intent || "general awareness",
          };
        }

        const formData = new FormData();

        if (videoBlob && videoBlob.size > 100) {
          formData.append("video", videoBlob, "video.webm");
        }

        if (audioBlob && audioBlob.size > 100) {
          formData.append("audio", audioBlob, "audio.webm");
        }

        formData.append("intent", intent || "general awareness");
        formData.append("currentMode", currentModeRef.current);
        formData.append("sessionId", recordingSessionIdRef.current.toString());

        console.log(
          `📨 Sending request to /api/gemini from session ${recordingSessionIdRef.current}...`,
        );

        const response = await fetch("/api/gemini", {
          method: "POST",
          body: formData,
        });

        console.log("📩 Response status:", response.status);

        if (!response.ok) {
          const errorText = await response.text();
          console.error("❌ API error:", errorText);
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const result = await response.json();

        if (result.success && result.data) {
          const geminiResponse: GeminiResponse = result.data;
          setCurrentMode(geminiResponse.mode);
          setLastTranscription(geminiResponse.transcription || "");

          // Reset retry count on success
          setRetryCount(0);
          lastAnalysisDataRef.current = null;

          const newRecording: Recording = {
            timestamp: new Date().toLocaleTimeString(),
            size: (videoBlob?.size || 0) + (audioBlob?.size || 0),
            processingTime: Date.now() - startTime,
            transcription: geminiResponse.transcription,
          };

          setRecordings((prev) => [newRecording, ...prev.slice(0, 9)]);

          if (geminiResponse.shouldRespond) {
            speakText(geminiResponse.speak);
          }

          return geminiResponse;
        } else {
          throw new Error(result.error || "Unknown error");
        }
      } catch (error) {
        console.error("❌ Analysis error:", error);
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        // Check if this is a retryable error and we haven't exceeded retry limit
        const isRetryableError =
          errorMessage.includes("Invalid_field") ||
          errorMessage.includes("timeout") ||
          errorMessage.includes("network");
        if (isRetryableError && retryCount < 3) {
          setRetryCount((prev) => prev + 1);
          console.log(`🔄 Retrying... Attempt ${retryCount + 1}/3`);

          // Wait a bit before retrying
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Don't reset analysis state for retry
          analysisInProgressRef.current = false;
          setIsProcessing(false);

          // Retry with same data
          if (lastAnalysisDataRef.current) {
            return analyzeWithGemini(lastAnalysisDataRef.current.intent, true);
          }
        } else {
          // Max retries reached or non-retryable error
          const ttsMessage =
            retryCount >= 3
              ? "An error occurred after multiple attempts. Please say that again."
              : "An error occurred. Please say that again.";

          setCurrentAnalysis(ttsMessage);
          speakText(ttsMessage);
          setRetryCount(0);
          lastAnalysisDataRef.current = null;
        }

        return null;
      } finally {
        setIsProcessing(false);
        isSpeechEndingRef.current = false;
        shouldSendRequestRef.current = false;
        analysisInProgressRef.current = false;

        console.log(`🔄 Analysis complete, restarting recording...`);

        try {
          await stopAllMediaRecorders();
          resetBuffers();

          if (streamRef.current) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            await startRecordingInternal(streamRef.current);
          }
        } catch (restartError) {
          console.error("❌ Failed to restart recording:", restartError);
        }
      }
    },
    [
      speakText,
      stopAllMediaRecorders,
      resetBuffers,
      startRecordingInternal,
      retryCount,
    ],
  );

  // Handle voice activity events
  const handleVoiceActivity = useCallback(
    (event: VoiceActivityEvent) => {
      if (event.type === "speech_start") {
        console.log(
          `🎙️ [Session ${recordingSessionIdRef.current}] Speech started`,
        );
        setIsUserSpeaking(true);
        setSpeechConfidence(event.confidence);
        isSpeechEndingRef.current = false;

        if (speechEndTimerRef.current) {
          clearTimeout(speechEndTimerRef.current);
          speechEndTimerRef.current = null;
        }
      } else if (event.type === "speech_active") {
        setSpeechConfidence(event.confidence);
      } else if (event.type === "speech_end") {
        console.log(
          `🎙️ [Session ${recordingSessionIdRef.current}] Speech ended (duration: ${event.duration}ms)`,
        );
        setIsUserSpeaking(false);
        setSpeechConfidence(0);

        if (isSpeechEndingRef.current || analysisInProgressRef.current) {
          return;
        }

        isSpeechEndingRef.current = true;

        speechEndTimerRef.current = setTimeout(async () => {
          if (!analysisInProgressRef.current) {
            console.log(
              `✅ [Session ${recordingSessionIdRef.current}] User finished speaking, checking buffers...`,
            );
            console.log("Video chunks:", videoChunksRef.current.length);
            console.log("Audio chunks:", audioChunksRef.current.length);

            if (audioChunksRef.current.length < 2) {
              console.log("⚠️ Not enough audio data, waiting...");
              setTimeout(async () => {
                if (
                  !analysisInProgressRef.current &&
                  audioChunksRef.current.length > 0
                ) {
                  console.log("✅ Sending delayed analysis...");
                  await analyzeWithGemini("user question");
                }
              }, 500);
              return;
            }

            console.log("✅ Sending to analysis...");
            await analyzeWithGemini("user question");
          }
          speechEndTimerRef.current = null;
        }, 800);
      }
    },
    [analyzeWithGemini],
  );

  // Audio visualization using VAD analyser
  useEffect(() => {
    if (!vadRef.current?.getAnalyser()) return;

    const analyser = vadRef.current.getAnalyser();
    if (!analyser) return;

    let animationFrame: number;

    const visualize = () => {
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      analyser.getByteFrequencyData(dataArray);

      const average = dataArray.reduce((a, b) => a + b) / bufferLength;
      const normalizedLevel = Math.min(1, average / 128);

      const time = Date.now() / 1000;
      const newLevels = Array(WAVE_BARS)
        .fill(0)
        .map((_, index) => {
          const wave = Math.sin(time * 3 + index * 0.5) * 0.3 + 0.7;
          const level = Math.max(
            WAVE_MIN_HEIGHT,
            Math.min(WAVE_MAX_HEIGHT, normalizedLevel * WAVE_MAX_HEIGHT * wave),
          );
          return level;
        });

      setAudioLevels(newLevels);
      animationFrame = requestAnimationFrame(visualize);
    };

    visualize();

    return () => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }
    };
  }, [hasPermissions]);

  // Recording timer
  useEffect(() => {
    if (!isRecording) return;

    let timer = 0;
    timerRef.current = setInterval(() => {
      timer += 1;
      setRecordingTimer(timer);
    }, 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isRecording]);

  // Auto-start on mount
  useEffect(() => {
    requestPermissions();
  }, []);

  // Cleanup
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (speechEndTimerRef.current) clearTimeout(speechEndTimerRef.current);
      stopAllMediaRecorders();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (vadRef.current) {
        vadRef.current.stop();
      }
      stopTTS();
    };
  }, [stopAllMediaRecorders, stopTTS]);

  const setupVideo = async (stream: MediaStream) => {
    if (!videoRef.current) {
      console.error("❌ Video ref is null");
      return;
    }

    console.log("🎥 Setting up video element...");
    console.log("Stream active:", stream.active);
    console.log("Video tracks:", stream.getVideoTracks().length);

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      console.log("Video track enabled:", videoTrack.enabled);
      console.log("Video track ready state:", videoTrack.readyState);
      console.log("Video track settings:", videoTrack.getSettings());
    }

    videoRef.current.srcObject = stream;
    videoRef.current.muted = true;
    videoRef.current.playsInline = true;
    videoRef.current.autoplay = true;

    // Force video attributes
    videoRef.current.setAttribute("autoplay", "");
    videoRef.current.setAttribute("playsinline", "");
    videoRef.current.setAttribute("muted", "");

    try {
      // Wait for metadata to load
      await new Promise<void>((resolve, reject) => {
        if (!videoRef.current) {
          reject(new Error("Video ref lost"));
          return;
        }

        videoRef.current.onloadedmetadata = () => {
          console.log("✅ Video metadata loaded");
          console.log(
            "Video dimensions:",
            videoRef.current?.videoWidth,
            "x",
            videoRef.current?.videoHeight,
          );
          resolve();
        };

        videoRef.current.onerror = (e) => {
          console.error("❌ Video element error:", e);
          reject(e);
        };

        // Timeout after 5 seconds
        setTimeout(() => reject(new Error("Metadata load timeout")), 5000);
      });

      // Now try to play
      await videoRef.current.play();
      setCameraReady(true);
      console.log("✅ Video element playing successfully");
      console.log("Video paused:", videoRef.current.paused);
      console.log("Video current time:", videoRef.current.currentTime);
    } catch (error) {
      console.error("❌ Video play failed:", error);
      // Still set camera ready to not block the UI
      setCameraReady(true);

      // Try to play again after a delay
      setTimeout(async () => {
        if (videoRef.current) {
          try {
            await videoRef.current.play();
            console.log("✅ Video play retry successful");
          } catch (retryError) {
            console.error("❌ Video play retry failed:", retryError);
          }
        }
      }, 1000);
    }
  };

  const requestPermissions = async () => {
    try {
      setIsInitializing(true);
      setPermissionError(null);

      console.log("🎥 Requesting media permissions...");

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 15 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
          channelCount: 1,
        },
      });

      console.log("✅ Got media stream");
      console.log("Stream ID:", stream.id);
      console.log("Stream active:", stream.active);
      console.log(
        "Video tracks:",
        stream.getVideoTracks().map((t) => ({
          id: t.id,
          label: t.label,
          enabled: t.enabled,
          readyState: t.readyState,
          settings: t.getSettings(),
        })),
      );
      console.log(
        "Audio tracks:",
        stream.getAudioTracks().map((t) => ({
          id: t.id,
          label: t.label,
          enabled: t.enabled,
          readyState: t.readyState,
        })),
      );

      streamRef.current = stream;

      // Setup video BEFORE initializing VAD
      await setupVideo(stream);
      console.log("✅ Video setup complete");

      // Initialize VAD
      vadRef.current = new VoiceActivityDetector({
        energyThreshold: 0.02,
        minSpeechDuration: 400,
        minSilenceDuration: 700,
      });

      await vadRef.current.init(stream, handleVoiceActivity);
      console.log("✅ VAD initialized");

      setHasPermissions(true);

      setTimeout(async () => {
        await startRecordingInternal(stream);
        setIsInitializing(false);
        console.log("✅ Recording started");
      }, 500);

      return true;
    } catch (error: any) {
      console.error("❌ Permission error:", error);
      console.error("Error name:", error.name);
      console.error("Error message:", error.message);
      setPermissionError("Failed to get camera/microphone permissions");
      setIsInitializing(false);
      return false;
    }
  };

  const stopRecording = async () => {
    console.log("=== Stopping Recording ===");

    setIsRecording(false);

    if (timerRef.current) clearInterval(timerRef.current);
    if (speechEndTimerRef.current) clearTimeout(speechEndTimerRef.current);

    await stopAllMediaRecorders();

    continuousModeRef.current = false;
    setCurrentMode("idle");
    setAudioLevels(Array(WAVE_BARS).fill(WAVE_MIN_HEIGHT));
    setRecordingTimer(0);
  };

  return (
    <div className="min-h-screen bg-black text-white p-4">
      <div className="max-w-2xl mx-auto space-y-4">
        {/* Main Status - Large and Clear */}
        <div className="text-center py-8">
          <h1 className="text-5xl font-bold mb-4">
            {isProcessing
              ? "Thinking..."
              : isUserSpeaking
                ? "Listening..."
                : "Ready"}
          </h1>
          {isRecording && (
            <div className="text-2xl text-gray-400">{recordingTimer}s</div>
          )}
          {retryCount > 0 && (
            <div className="text-xl text-yellow-400 mt-2">
              Retrying... ({retryCount}/3)
            </div>
          )}
        </div>

        {/* Camera Feed - Now Visible */}
        <div className="bg-gray-900 rounded-3xl overflow-hidden">
          <div className="relative aspect-video bg-black">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
              style={{ display: "block" }}
            />
            {!cameraReady && hasPermissions && (
              <div className="absolute inset-0 flex items-center justify-center bg-black">
                <div className="text-center">
                  <Loader2 className="w-12 h-12 text-blue-400 animate-spin mx-auto mb-4" />
                  <div className="text-xl">Starting camera...</div>
                </div>
              </div>
            )}
            {!hasPermissions && (
              <div className="absolute inset-0 flex items-center justify-center bg-black">
                <Camera className="w-24 h-24 text-gray-600" />
              </div>
            )}
            {isRecording && hasPermissions && (
              <div className="absolute top-4 right-4">
                <div className="flex items-center gap-2 bg-red-600 px-4 py-2 rounded-full">
                  <div className="w-3 h-3 bg-white rounded-full animate-pulse" />
                  <span className="text-sm font-bold">REC</span>
                </div>
              </div>
            )}
            {isProcessing && (
              <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
                <div className="text-center">
                  <Loader2 className="w-16 h-16 text-blue-400 animate-spin mx-auto mb-4" />
                  <div className="text-2xl font-bold">Analyzing...</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Audio Visualization - Simple and Large */}
        <div className="bg-gray-900 rounded-3xl p-8">
          <div className="flex items-end justify-center gap-2 h-32">
            {audioLevels.map((level, index) => (
              <div
                key={index}
                className={`w-full rounded-t-lg transition-all duration-75 ${
                  isUserSpeaking ? "bg-green-500" : "bg-blue-500"
                }`}
                style={{ height: `${level}px` }}
              />
            ))}
          </div>
        </div>

        {/* AI Response - Large Text */}
        {currentAnalysis && (
          <div className="bg-blue-900 rounded-3xl p-8">
            <div className="text-2xl leading-relaxed">{currentAnalysis}</div>
          </div>
        )}

        {/* Last Spoken Text */}
        {lastTranscription && (
          <div className="bg-gray-800 rounded-3xl p-6">
            <div className="text-sm text-gray-400 mb-2">You said:</div>
            <div className="text-xl">{lastTranscription}</div>
          </div>
        )}

        {/* Simple Controls */}
        {!hasPermissions ? (
          <button
            onClick={requestPermissions}
            disabled={isInitializing}
            className="w-full py-8 text-3xl font-bold bg-blue-600 hover:bg-blue-700 rounded-3xl disabled:opacity-50"
          >
            {isInitializing ? "Starting..." : "Start Assistant"}
          </button>
        ) : (
          <div className="flex gap-4">
            {isRecording ? (
              <button
                onClick={stopRecording}
                disabled={isProcessing}
                className="flex-1 py-8 text-3xl font-bold bg-red-600 hover:bg-red-700 rounded-3xl disabled:opacity-50"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={() =>
                  streamRef.current && startRecordingInternal(streamRef.current)
                }
                className="flex-1 py-8 text-3xl font-bold bg-green-600 hover:bg-green-700 rounded-3xl"
              >
                Start
              </button>
            )}
          </div>
        )}

        {/* Error Display */}
        {permissionError && (
          <div className="bg-red-900 rounded-3xl p-6 text-center text-xl">
            {permissionError}
          </div>
        )}

        {/* Status Indicators - Minimal */}
        <div className="flex justify-center gap-8 text-center">
          <div>
            <div
              className={`w-6 h-6 rounded-full mx-auto mb-2 ${isUserSpeaking ? "bg-green-500 animate-pulse" : "bg-gray-600"}`}
            />
            <div className="text-sm text-gray-400">Speaking</div>
          </div>
          <div>
            <div
              className={`w-6 h-6 rounded-full mx-auto mb-2 ${ttsSpeaking ? "bg-blue-500 animate-pulse" : "bg-gray-600"}`}
            />
            <div className="text-sm text-gray-400">AI Talking</div>
          </div>
          <div>
            <div
              className={`w-6 h-6 rounded-full mx-auto mb-2 ${isProcessing ? "bg-yellow-500 animate-pulse" : "bg-gray-600"}`}
            />
            <div className="text-sm text-gray-400">Processing</div>
          </div>
        </div>
      </div>
    </div>
  );
}
