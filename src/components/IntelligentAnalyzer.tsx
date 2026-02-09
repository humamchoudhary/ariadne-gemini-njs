"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Camera,
  Mic,
  Play,
  Square,
  Volume2,
  VolumeX,
  Activity,
  Clock,
  Sparkles,
  AlertCircle,
} from "lucide-react";
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
  analysis: string;
  mode: AnalysisMode;
  reason: string;
  shouldRespond: boolean;
  transcription?: string;
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

  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderVideoRef = useRef<MediaRecorder | null>(null);
  const mediaRecorderAudioRef = useRef<MediaRecorder | null>(null);
  const videoChunksRef = useRef<
    { data: ArrayBuffer; timestamp: number; mimeType: string }[]
  >([]);
  const audioChunksRef = useRef<
    { data: ArrayBuffer; timestamp: number; mimeType: string }[]
  >([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const vadRef = useRef<VoiceActivityDetector | null>(null);
  const speechEndTimerRef = useRef<NodeJS.Timeout | null>(null);
  const continuousModeRef = useRef(false);
  const isSpeechEndingRef = useRef(false);

  const currentModeRef = useRef<AnalysisMode>(currentMode);
  const isProcessingRef = useRef(isProcessing);

  useEffect(() => {
    currentModeRef.current = currentMode;
  }, [currentMode]);

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  // Clean old chunks periodically
  const cleanOldChunks = useCallback(() => {
    const now = Date.now();
    const cutoffTime = now - CAPTURE_WINDOW_SECONDS * 1000;

    videoChunksRef.current = videoChunksRef.current.filter(
      (chunk) => chunk.timestamp > cutoffTime,
    );
    audioChunksRef.current = audioChunksRef.current.filter(
      (chunk) => chunk.timestamp > cutoffTime,
    );
  }, []);

  // Stop all media recorders properly
  const stopAllMediaRecorders = useCallback(async () => {
    console.log("🛑 Stopping all media recorders...");

    // Stop video recorder
    if (mediaRecorderVideoRef.current) {
      if (mediaRecorderVideoRef.current.state === "recording") {
        mediaRecorderVideoRef.current.stop();
      }
      mediaRecorderVideoRef.current = null;
    }

    // Stop audio recorder
    if (mediaRecorderAudioRef.current) {
      if (mediaRecorderAudioRef.current.state === "recording") {
        mediaRecorderAudioRef.current.stop();
      }
      mediaRecorderAudioRef.current = null;
    }

    // Clear chunks
    videoChunksRef.current = [];
    audioChunksRef.current = [];

    // Reset chunk arrays
    videoChunksRef.current = [];
    audioChunksRef.current = [];
  }, []);

  // Send data to Gemini API
  const analyzeWithGemini = async (
    intent?: string,
  ): Promise<GeminiResponse | null> => {
    try {
      setIsProcessing(true);
      const startTime = Date.now();

      // Create blobs from all available chunks
      let videoBlob: Blob | null = null;
      let audioBlob: Blob | null = null;

      if (videoChunksRef.current.length > 0) {
        const videoDataArray = videoChunksRef.current.map(
          (chunk) => new Uint8Array(chunk.data),
        );
        const totalVideoSize = videoDataArray.reduce(
          (sum, arr) => sum + arr.length,
          0,
        );
        const combinedVideoArray = new Uint8Array(totalVideoSize);

        let offset = 0;
        videoDataArray.forEach((arr) => {
          combinedVideoArray.set(arr, offset);
          offset += arr.length;
        });

        videoBlob = new Blob([combinedVideoArray], {
          type: "video/webm;codecs=vp8",
        });
        console.log(`📹 Video size: ${(videoBlob.size / 1024).toFixed(2)} KB`);
      }

      if (audioChunksRef.current.length > 0) {
        const audioDataArray = audioChunksRef.current.map(
          (chunk) => new Uint8Array(chunk.data),
        );
        const totalAudioSize = audioDataArray.reduce(
          (sum, arr) => sum + arr.length,
          0,
        );
        const combinedAudioArray = new Uint8Array(totalAudioSize);

        let offset = 0;
        audioDataArray.forEach((arr) => {
          combinedAudioArray.set(arr, offset);
          offset += arr.length;
        });

        audioBlob = new Blob([combinedAudioArray], {
          type: "audio/webm;codecs=opus",
        });
        console.log(`🎤 Audio size: ${(audioBlob.size / 1024).toFixed(2)} KB`);
      }

      // Stop recorders before sending to avoid conflicts
      await stopAllMediaRecorders();

      const formData = new FormData();

      if (videoBlob && videoBlob.size > 0) {
        formData.append("video", videoBlob, "video.webm");
      }

      if (audioBlob && audioBlob.size > 0) {
        formData.append("audio", audioBlob, "audio.webm");
      }

      formData.append("intent", intent || "general awareness");
      formData.append("currentMode", currentModeRef.current);

      const response = await fetch("/api/gemini", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();

      if (result.success && result.data) {
        const geminiResponse: GeminiResponse = result.data;
        setCurrentAnalysis(geminiResponse.analysis);
        setCurrentMode(geminiResponse.mode);
        setLastTranscription(geminiResponse.transcription || "");

        // Add to recordings history
        const newRecording: Recording = {
          timestamp: new Date().toLocaleTimeString(),
          size: (videoBlob?.size || 0) + (audioBlob?.size || 0),
          analysis: geminiResponse.analysis,
          processingTime: Date.now() - startTime,
          transcription: geminiResponse.transcription,
        };

        setRecordings((prev) => [newRecording, ...prev.slice(0, 9)]);

        // Speak if needed
        if (geminiResponse.shouldRespond) {
          speakText(geminiResponse.analysis);
        }

        // Restart recording if in continuous mode or idle
        if (
          geminiResponse.mode === "continuous" ||
          geminiResponse.mode === "idle"
        ) {
          setTimeout(() => {
            if (streamRef.current) {
              startRecordingInternal(streamRef.current);
            }
          }, 1000); // Wait 1 second before restarting
        }

        return geminiResponse;
      } else {
        throw new Error(result.error || "Unknown error");
      }
    } catch (error) {
      console.error("❌ Analysis error:", error);
      setCurrentAnalysis("Error analyzing content. Please try again.");
      return null;
    } finally {
      setIsProcessing(false);
      isSpeechEndingRef.current = false;
    }
  };

  // Handle voice activity events
  const handleVoiceActivity = useCallback(
    (event: VoiceActivityEvent) => {
      if (event.type === "speech_start") {
        console.log("🎙️ Speech started");
        setIsUserSpeaking(true);
        setSpeechConfidence(event.confidence);
        isSpeechEndingRef.current = false;

        // Clear any pending speech end timer
        if (speechEndTimerRef.current) {
          clearTimeout(speechEndTimerRef.current);
          speechEndTimerRef.current = null;
        }
      } else if (event.type === "speech_active") {
        setSpeechConfidence(event.confidence);
      } else if (event.type === "speech_end") {
        console.log(`🎙️ Speech ended (duration: ${event.duration}ms)`);
        setIsUserSpeaking(false);
        setSpeechConfidence(0);

        // Prevent multiple speech end events
        if (isSpeechEndingRef.current) {
          return;
        }

        isSpeechEndingRef.current = true;

        // Wait a moment before analyzing to catch any final audio
        speechEndTimerRef.current = setTimeout(async () => {
          if (
            !isProcessingRef.current &&
            currentModeRef.current !== "continuous"
          ) {
            console.log("✅ User finished speaking, analyzing...");

            // Set mode to single for questions
            if (currentModeRef.current === "idle") {
              setCurrentMode("single");
            }

            await analyzeWithGemini("user question");
          }
          speechEndTimerRef.current = null;
        }, 800); // Increased from 500ms to 800ms for better audio capture
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

  // Periodic cleanup
  useEffect(() => {
    if (!isRecording) return;

    const cleanupInterval = setInterval(() => {
      cleanOldChunks();
    }, 2000);

    return () => clearInterval(cleanupInterval);
  }, [isRecording, cleanOldChunks]);

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
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [stopAllMediaRecorders]);

  const setupVideo = async (stream: MediaStream) => {
    if (!videoRef.current) return;

    videoRef.current.srcObject = stream;
    try {
      await videoRef.current.play();
      setCameraReady(true);
    } catch (error) {
      console.warn("Video play failed:", error);
      setCameraReady(true);
    }
  };

  const requestPermissions = async () => {
    try {
      setIsInitializing(true);
      setPermissionError(null);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
        },
      });

      streamRef.current = stream;
      await setupVideo(stream);

      // Initialize VAD
      vadRef.current = new VoiceActivityDetector({
        energyThreshold: 0.02,
        minSpeechDuration: 400,
        minSilenceDuration: 700,
      });

      await vadRef.current.init(stream, handleVoiceActivity);

      setHasPermissions(true);
      await startRecordingInternal(stream);
      setIsInitializing(false);

      return true;
    } catch (error: any) {
      console.error("Permission error:", error);
      setPermissionError("Failed to get camera/microphone permissions");
      setIsInitializing(false);
      return false;
    }
  };

  const startRecordingInternal = async (stream?: MediaStream) => {
    const activeStream = stream || streamRef.current;

    if (!activeStream) {
      console.error("No stream available");
      return;
    }

    console.log("=== Starting Recording with VAD ===");

    // Ensure no existing recorders are running
    await stopAllMediaRecorders();

    // Clear existing chunks
    videoChunksRef.current = [];
    audioChunksRef.current = [];

    // Get fresh tracks from stream
    const videoTrack = activeStream.getVideoTracks()[0];
    const audioTrack = activeStream.getAudioTracks()[0];

    if (!videoTrack || !audioTrack) {
      console.error("Missing video or audio track");
      return;
    }

    // Create fresh streams for each recorder
    const videoStream = new MediaStream([videoTrack]);
    const audioStream = new MediaStream([audioTrack]);

    // VIDEO RECORDER
    try {
      mediaRecorderVideoRef.current = new MediaRecorder(videoStream, {
        mimeType: "video/webm;codecs=vp8",
        videoBitsPerSecond: 300000,
      });

      mediaRecorderVideoRef.current.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          const arrayBuffer = await event.data.arrayBuffer();
          videoChunksRef.current.push({
            data: arrayBuffer,
            timestamp: Date.now(),
            mimeType: event.data.type,
          });

          // Keep only recent chunks
          const cutoffTime = Date.now() - CAPTURE_WINDOW_SECONDS * 1000;
          videoChunksRef.current = videoChunksRef.current.filter(
            (chunk) => chunk.timestamp > cutoffTime,
          );
        }
      };

      mediaRecorderVideoRef.current.start(1000); // Collect data every second
    } catch (error) {
      console.error("Failed to start video recorder:", error);
      mediaRecorderVideoRef.current = null;
    }

    // AUDIO RECORDER
    try {
      mediaRecorderAudioRef.current = new MediaRecorder(audioStream, {
        mimeType: "audio/webm;codecs=opus",
        audioBitsPerSecond: 32000,
      });

      mediaRecorderAudioRef.current.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          const arrayBuffer = await event.data.arrayBuffer();
          audioChunksRef.current.push({
            data: arrayBuffer,
            timestamp: Date.now(),
            mimeType: event.data.type,
          });

          // Keep only recent chunks
          const cutoffTime = Date.now() - CAPTURE_WINDOW_SECONDS * 1000;
          audioChunksRef.current = audioChunksRef.current.filter(
            (chunk) => chunk.timestamp > cutoffTime,
          );
        }
      };

      mediaRecorderAudioRef.current.start(1000); // Collect data every second
    } catch (error) {
      console.error("Failed to start audio recorder:", error);
      mediaRecorderAudioRef.current = null;
    }

    setIsRecording(true);
    setRecordingTimer(0);
    console.log("✅ Recording started successfully");
  };

  const stopRecording = async () => {
    console.log("=== Stopping Recording ===");

    setIsRecording(false);

    if (timerRef.current) clearInterval(timerRef.current);
    if (speechEndTimerRef.current) clearTimeout(speechEndTimerRef.current);

    // Stop and cleanup MediaRecorders
    await stopAllMediaRecorders();

    continuousModeRef.current = false;
    setCurrentMode("idle");
    setAudioLevels(Array(WAVE_BARS).fill(WAVE_MIN_HEIGHT));
    setRecordingTimer(0);
  };

  const speakText = (text: string) => {
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
  };

  const stopTTS = () => {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      setTtsSpeaking(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const formatTime = (ms: number) => {
    return (ms / 1000).toFixed(1) + "s";
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0F0C1F] via-[#1A1538] to-[#0F0C1F] text-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold bg-gradient-to-r from-violet-400 to-purple-600 bg-clip-text text-transparent flex items-center gap-3">
              <Sparkles className="w-10 h-10 text-violet-400" />
              AI Vision Assistant
            </h1>
            <p className="text-slate-400 mt-1">
              Advanced VAD • {CAPTURE_WINDOW_SECONDS}s Rolling Buffer • Smart
              Analysis
            </p>
          </div>
        </div>

        {/* Status Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Mode Status */}
          <div className="bg-[#1A1538] rounded-2xl p-6 border border-slate-700">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-slate-400">Current Mode</div>
              <Activity className="w-5 h-5 text-violet-400" />
            </div>
            <div className="text-2xl font-bold text-violet-400">
              {currentMode.toUpperCase()}
            </div>
            <div className="text-sm text-slate-300 mt-2">
              {currentMode === "idle" && "Waiting for voice input..."}
              {currentMode === "single" && "Processing your question..."}
              {currentMode === "continuous" && "Continuous navigation mode"}
            </div>
          </div>

          {/* Speech Status */}
          <div className="bg-[#1A1538] rounded-2xl p-6 border border-slate-700">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-slate-400">Voice Activity</div>
              <Mic
                className={`w-5 h-5 ${isUserSpeaking ? "text-green-400" : "text-slate-500"}`}
              />
            </div>
            <div
              className={`text-2xl font-bold ${isUserSpeaking ? "text-green-400" : "text-slate-500"}`}
            >
              {isUserSpeaking ? "SPEAKING" : "SILENT"}
            </div>
            <div className="text-sm text-slate-300 mt-2">
              Confidence: {(speechConfidence * 100).toFixed(0)}%
            </div>
          </div>

          {/* Buffer Status */}
          <div className="bg-[#1A1538] rounded-2xl p-6 border border-slate-700">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-slate-400">Buffer Status</div>
              <Clock className="w-5 h-5 text-violet-400" />
            </div>
            <div className="text-2xl font-bold text-violet-400">
              {videoChunksRef.current.length + audioChunksRef.current.length}
            </div>
            <div className="text-sm text-slate-300 mt-2">
              {videoChunksRef.current.length}V + {audioChunksRef.current.length}
              A chunks
            </div>
          </div>
        </div>

        {/* Camera Preview */}
        <div className="bg-[#1A1538] rounded-2xl p-6 border border-slate-700">
          <div className="flex items-center gap-2 mb-4">
            <Camera className="w-5 h-5 text-violet-400" />
            <span className="font-semibold">Live Camera Feed</span>
            {isRecording && (
              <span className="ml-auto text-sm text-green-400 flex items-center gap-2">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                Recording
              </span>
            )}
            {isProcessing && (
              <span className="ml-2 text-sm text-violet-400 flex items-center gap-2">
                <div className="w-2 h-2 bg-violet-400 rounded-full animate-pulse" />
                Processing
              </span>
            )}
          </div>

          <div className="relative aspect-video bg-black rounded-xl overflow-hidden">
            {hasPermissions ? (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                {isProcessing && (
                  <div className="absolute top-4 right-4 bg-violet-500/80 backdrop-blur-sm px-4 py-2 rounded-lg flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span className="font-semibold">
                      Analyzing with Gemini...
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                <Camera className="w-16 h-16 text-slate-600" />
                <div className="text-slate-400 text-center">
                  <div className="font-semibold mb-1">Permissions Required</div>
                  <div className="text-sm">Enable camera and microphone</div>
                </div>
                {permissionError && (
                  <div className="flex items-center gap-2 text-red-400 text-sm">
                    <AlertCircle className="w-4 h-4" />
                    {permissionError}
                  </div>
                )}
                <button
                  onClick={requestPermissions}
                  disabled={isInitializing}
                  className="px-5 py-2.5 bg-violet-600 hover:bg-violet-700 rounded-xl font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isInitializing ? "Initializing..." : "Enable Camera & Mic"}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Audio Visualization */}
        <div className="bg-[#1A1538] rounded-2xl p-6 border border-slate-700">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Mic className="w-5 h-5 text-violet-400" />
              <span className="font-semibold">
                {isUserSpeaking ? "🎙️ User Speaking" : "Audio Monitor"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {ttsSpeaking ? (
                <Volume2 className="w-5 h-5 text-green-400 animate-pulse" />
              ) : (
                <VolumeX className="w-5 h-5 text-slate-500" />
              )}
            </div>
          </div>

          <div className="flex items-end justify-center gap-1 h-20">
            {audioLevels.map((level, index) => (
              <div
                key={index}
                className={`w-full rounded-t-lg transition-all duration-75 ${
                  isUserSpeaking
                    ? "bg-gradient-to-t from-green-600 to-green-400"
                    : "bg-gradient-to-t from-violet-600 to-purple-400"
                }`}
                style={{ height: `${level}px` }}
              />
            ))}
          </div>

          {lastTranscription && (
            <div className="mt-4 p-3 bg-[#0F0C1F] rounded-lg border border-slate-700">
              <div className="text-xs text-slate-400 mb-1">
                Last Detected Speech:
              </div>
              <div className="text-sm text-slate-200">{lastTranscription}</div>
            </div>
          )}
        </div>

        {/* Current Analysis */}
        {currentAnalysis && (
          <div className="bg-gradient-to-br from-violet-900/30 to-purple-900/30 rounded-2xl p-6 border border-violet-500/30">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-5 h-5 text-violet-400" />
              <span className="font-semibold text-violet-300">AI Analysis</span>
            </div>
            <div className="text-slate-100 leading-relaxed text-lg">
              {currentAnalysis}
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="flex gap-4">
          {!isRecording ? (
            <button
              onClick={() => {
                if (!hasPermissions) {
                  requestPermissions();
                } else if (streamRef.current) {
                  startRecordingInternal(streamRef.current);
                }
              }}
              disabled={isProcessing || isInitializing}
              className="flex-1 py-4 rounded-xl font-bold text-lg transition-all bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
            >
              <Play className="w-6 h-6" />
              {isInitializing ? "INITIALIZING..." : "START VOICE ASSISTANT"}
            </button>
          ) : (
            <button
              onClick={stopRecording}
              disabled={isProcessing}
              className="flex-1 py-4 rounded-xl font-bold text-lg bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Square className="w-6 h-6" />
              STOP ASSISTANT ({recordingTimer}s)
            </button>
          )}

          <button
            onClick={
              ttsSpeaking
                ? stopTTS
                : () => speakText("Voice assistant is ready")
            }
            disabled={isProcessing}
            className="px-5 py-2.5 border-2 border-violet-500 text-violet-500 rounded-xl font-semibold hover:bg-violet-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {ttsSpeaking ? "Stop TTS" : "Test TTS"}
          </button>
        </div>

        {/* Analysis History */}
        {recordings.length > 0 && (
          <div className="bg-[#1A1538] rounded-2xl p-6 border border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-violet-400" />
                <span className="font-semibold">Analysis History</span>
              </div>
              <span className="text-sm text-slate-400">
                {recordings.length} entries
              </span>
            </div>

            <div className="space-y-3 max-h-96 overflow-y-auto">
              {recordings.map((recording, index) => (
                <div
                  key={index}
                  className="bg-[#0F0C1F] rounded-xl p-4 border border-slate-700"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-mono text-sm text-violet-400">
                      #{recordings.length - index} • {recording.timestamp}
                    </div>
                    <div className="text-xs text-slate-500">
                      {formatBytes(recording.size)} •{" "}
                      {formatTime(recording.processingTime || 0)}
                    </div>
                  </div>

                  {recording.transcription && (
                    <div className="mb-2 p-2 bg-slate-800/50 rounded text-xs text-slate-300">
                      <span className="text-slate-500">User said:</span> "
                      {recording.transcription}"
                    </div>
                  )}

                  {recording.analysis && (
                    <div className="text-sm text-slate-300 leading-relaxed">
                      {recording.analysis}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Info Panel */}
        <div className="bg-[#1A1538] rounded-2xl p-6 border border-slate-700">
          <h3 className="font-semibold mb-3 flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-violet-400" />
            How It Works
          </h3>
          <div className="space-y-2 text-sm text-slate-300">
            <div className="flex items-start gap-2">
              <div className="w-6 h-6 rounded-full bg-violet-500 flex items-center justify-center flex-shrink-0 text-xs font-bold">
                1
              </div>
              <p>
                Advanced voice activity detection (VAD) continuously monitors
                your speech
              </p>
            </div>
            <div className="flex items-start gap-2">
              <div className="w-6 h-6 rounded-full bg-violet-500 flex items-center justify-center flex-shrink-0 text-xs font-bold">
                2
              </div>
              <p>
                When you speak, the last {CAPTURE_WINDOW_SECONDS} seconds of
                video and audio are captured
              </p>
            </div>
            <div className="flex items-start gap-2">
              <div className="w-6 h-6 rounded-full bg-violet-500 flex items-center justify-center flex-shrink-0 text-xs font-bold">
                3
              </div>
              <p>
                Gemini AI analyzes the content and provides voice guidance for
                navigation and safety
              </p>
            </div>
            <div className="flex items-start gap-2">
              <div className="w-6 h-6 rounded-full bg-violet-500 flex items-center justify-center flex-shrink-0 text-xs font-bold">
                4
              </div>
              <p>
                The system intelligently decides when to speak based on context
                and user needs
              </p>
            </div>
          </div>
        </div>

        {/* Debug Info (remove in production) */}
        {process.env.NODE_ENV === "development" && (
          <div className="bg-red-900/20 rounded-2xl p-4 border border-red-700/50">
            <h4 className="font-semibold text-red-300 mb-2">Debug Info</h4>
            <div className="text-xs text-red-200 space-y-1">
              <div>Video chunks: {videoChunksRef.current.length}</div>
              <div>Audio chunks: {audioChunksRef.current.length}</div>
              <div>
                Is speech ending: {isSpeechEndingRef.current ? "Yes" : "No"}
              </div>
              <div>Is processing: {isProcessingRef.current ? "Yes" : "No"}</div>
              <div>Current mode: {currentModeRef.current}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
