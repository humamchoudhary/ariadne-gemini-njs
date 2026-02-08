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
} from "lucide-react";

const WAVE_BARS = 20;
const WAVE_MAX_HEIGHT = 60;
const WAVE_MIN_HEIGHT = 4;

// CRITICAL: Only keep last N seconds of recording
const CAPTURE_WINDOW_SECONDS = 5; // Only send last 5 seconds to API

// Modes for intelligent triggering
type AnalysisMode = "idle" | "continuous" | "single";

interface Recording {
  timestamp: string;
  size: number;
  analysis?: string;
  processingTime?: number;
}

interface GeminiResponse {
  analysis: string;
  mode: AnalysisMode;
  reason: string;
  shouldRespond: boolean;
}

export default function IntelligentAnalyzer() {
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
  const [isRequestingPermissions, setIsRequestingPermissions] = useState(false);
  const [currentMode, setCurrentMode] = useState<AnalysisMode>("idle");
  const [userIntent, setUserIntent] = useState<string | null>(null);
  const [lastUserSpeech, setLastUserSpeech] = useState(0);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderVideoRef = useRef<MediaRecorder | null>(null);
  const mediaRecorderAudioRef = useRef<MediaRecorder | null>(null);

  // ROLLING BUFFER: Keep only last N seconds of chunks with timestamps
  const videoChunksRef = useRef<{ blob: Blob; timestamp: number }[]>([]);
  const audioChunksRef = useRef<{ blob: Blob; timestamp: number }[]>([]);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const speechSynthesisRef = useRef<SpeechSynthesisUtterance | null>(null);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const continuousModeRef = useRef(false);

  // Use refs to track latest values without triggering re-renders
  const currentModeRef = useRef<AnalysisMode>(currentMode);
  const lastUserSpeechRef = useRef(0);
  const isProcessingRef = useRef(isProcessing);

  // Update refs when state changes
  useEffect(() => {
    currentModeRef.current = currentMode;
  }, [currentMode]);

  useEffect(() => {
    lastUserSpeechRef.current = lastUserSpeech;
  }, [lastUserSpeech]);

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  // Clean old chunks periodically (keep only last N seconds)
  const cleanOldChunks = useCallback(() => {
    const now = Date.now();
    const cutoffTime = now - CAPTURE_WINDOW_SECONDS * 1000;

    // Remove chunks older than N seconds
    videoChunksRef.current = videoChunksRef.current.filter(
      (chunk) => chunk.timestamp > cutoffTime,
    );
    audioChunksRef.current = audioChunksRef.current.filter(
      (chunk) => chunk.timestamp > cutoffTime,
    );
  }, []);

  // Send data to server-side Gemini API
  const analyzeWithGemini = async (
    intent?: string,
  ): Promise<GeminiResponse | null> => {
    try {
      setIsProcessing(true);
      const startTime = Date.now();

      // Clean old chunks before analyzing
      cleanOldChunks();

      console.log(
        `📊 Sending last ${CAPTURE_WINDOW_SECONDS}s: ${videoChunksRef.current.length} video chunks, ${audioChunksRef.current.length} audio chunks`,
      );

      // Create FormData with ONLY the last N seconds
      const formData = new FormData();

      if (videoChunksRef.current.length > 0) {
        const videoBlobs = videoChunksRef.current.map((chunk) => chunk.blob);
        const videoBlob = new Blob(videoBlobs, { type: "video/webm" });
        formData.append("video", videoBlob, "video.webm");
        console.log(`📹 Video size: ${(videoBlob.size / 1024).toFixed(2)} KB`);
      }

      if (audioChunksRef.current.length > 0) {
        const audioBlobs = audioChunksRef.current.map((chunk) => chunk.blob);
        const audioBlob = new Blob(audioBlobs, { type: "audio/webm" });
        formData.append("audio", audioBlob, "audio.webm");
        console.log(`🎤 Audio size: ${(audioBlob.size / 1024).toFixed(2)} KB`);
      }

      // Calculate size for history
      const dataSize =
        videoChunksRef.current.reduce(
          (sum, chunk) => sum + chunk.blob.size,
          0,
        ) +
        audioChunksRef.current.reduce((sum, chunk) => sum + chunk.blob.size, 0);

      formData.append("intent", intent || "general awareness");
      formData.append("currentMode", currentModeRef.current);

      // Call server-side API
      const response = await fetch("/api/gemini", {
        method: "POST",
        body: formData,
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || "Analysis failed");
      }

      const geminiResponse: GeminiResponse = result.data;

      // Update current mode based on Gemini's decision
      setCurrentMode(geminiResponse.mode);
      setCurrentAnalysis(geminiResponse.analysis);

      // Add to history
      const newRecording: Recording = {
        timestamp: new Date().toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
        size: dataSize,
        analysis: geminiResponse.analysis,
        processingTime: Date.now() - startTime,
      };

      setRecordings((prev) => [newRecording, ...prev.slice(0, 9)]);

      // Only speak the analysis if Gemini decided it should respond
      if (geminiResponse.shouldRespond) {
        console.log("🔊 Speaking response to user");
        speakText(geminiResponse.analysis);
      } else {
        console.log("🔇 Skipping TTS - no significant changes to report");
      }

      console.log(`Gemini analysis: ${geminiResponse.analysis}`);
      console.log(
        `Mode set to: ${geminiResponse.mode} (${geminiResponse.reason})`,
      );
      console.log(`Should respond: ${geminiResponse.shouldRespond}`);

      return geminiResponse;
    } catch (error) {
      console.error("Analysis error:", error);
      return null;
    } finally {
      setIsProcessing(false);
    }
  };

  // Intelligent capture and analysis
  const captureAndAnalyze = useCallback(
    async (intent?: string) => {
      if (isProcessingRef.current) return;

      console.log(`Triggering analysis: ${intent || "automatic"}`);
      const result = await analyzeWithGemini(intent);

      if (result) {
        // Handle mode transitions
        if (result.mode === "continuous") {
          continuousModeRef.current = true;
          // Start continuous analysis loop
          startContinuousAnalysis();
        } else if (result.mode === "idle") {
          continuousModeRef.current = false;
        }
      }
    },
    [], // Empty dependency array since we use refs
  );

  // Continuous analysis for navigation mode
  const startContinuousAnalysis = useCallback(() => {
    if (!continuousModeRef.current) return;

    const analyzeContinuously = async () => {
      if (!continuousModeRef.current) return;

      await captureAndAnalyze("continuous navigation");

      // Schedule next analysis in 3 seconds
      setTimeout(analyzeContinuously, 3000);
    };

    // Start the loop
    setTimeout(analyzeContinuously, 3000);
  }, [captureAndAnalyze]);

  // Voice commands processing
  const processVoiceCommand = useCallback(
    (command: string) => {
      console.log("Processing voice command:", command);
      const lowerCommand = command.toLowerCase();

      // Navigation commands
      if (
        lowerCommand.includes("navigate") ||
        lowerCommand.includes("guide me")
      ) {
        if (lowerCommand.includes("out") || lowerCommand.includes("exit")) {
          setUserIntent("navigate out of room");
          setCurrentMode("continuous");
          captureAndAnalyze("navigate me out of this room");
          return;
        }
      }

      // Question commands
      if (lowerCommand.includes("what") || lowerCommand.includes("describe")) {
        if (
          lowerCommand.includes("front") ||
          lowerCommand.includes("ahead") ||
          lowerCommand.includes("in front")
        ) {
          setUserIntent("describe front");
          setCurrentMode("single");
          captureAndAnalyze("what is in front of me");
          return;
        }
      }

      if (
        lowerCommand.includes("surrounding") ||
        lowerCommand.includes("around me")
      ) {
        setUserIntent("describe surroundings");
        setCurrentMode("single");
        captureAndAnalyze("describe my surroundings");
        return;
      }

      // Stop command
      if (lowerCommand.includes("stop") || lowerCommand.includes("enough")) {
        setCurrentMode("idle");
        setUserIntent(null);
        continuousModeRef.current = false;
        speakText("Stopping analysis. Going to idle mode.");
        return;
      }

      // General awareness in single mode
      setUserIntent("general awareness");
      setCurrentMode("single");
      captureAndAnalyze(command);
    },
    [captureAndAnalyze],
  );

  // Voice activity detection
  const detectVoiceActivity = useCallback(() => {
    if (!analyserRef.current) return 0;

    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyserRef.current.getByteFrequencyData(dataArray);

    const average = dataArray.reduce((a, b) => a + b) / bufferLength;
    const normalizedLevel = Math.min(1, average / 128);

    // Voice activity threshold
    const VOICE_THRESHOLD = 0.15;
    const currentTime = Date.now();

    if (normalizedLevel > VOICE_THRESHOLD) {
      // User is speaking
      if (!isUserSpeaking) {
        setIsUserSpeaking(true);
        console.log("User started speaking...");
      }
      setLastUserSpeech(currentTime);

      // Clear any existing silence timer
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
    } else {
      // User is silent
      if (isUserSpeaking) {
        setIsUserSpeaking(false);
        console.log("User went silent...");
      }

      // Start silence timer only if we recently detected speech
      const timeSinceLastSpeech = currentTime - lastUserSpeechRef.current;

      if (
        timeSinceLastSpeech < 3000 &&
        timeSinceLastSpeech > 0 &&
        lastUserSpeechRef.current > 0 &&
        !silenceTimerRef.current
      ) {
        console.log("Starting silence timer (2s)...");
        silenceTimerRef.current = setTimeout(() => {
          const finalTimeSinceLastSpeech =
            Date.now() - lastUserSpeechRef.current;
          console.log(
            `User stopped speaking, checking if we should analyze... (mode: ${currentModeRef.current}, time since speech: ${finalTimeSinceLastSpeech}ms)`,
          );

          if (finalTimeSinceLastSpeech < 5000 && finalTimeSinceLastSpeech > 0) {
            console.log("✅ User asked a question, analyzing...");

            if (currentModeRef.current === "idle") {
              setCurrentMode("single");
            }

            captureAndAnalyze("user question");
          } else {
            console.log(
              "❌ Too much time passed since speech, skipping analysis",
            );
          }

          silenceTimerRef.current = null;
        }, 2000);
      }
    }

    return normalizedLevel;
  }, [captureAndAnalyze]);

  // Audio level monitoring for voice activity - ALWAYS ACTIVE
  useEffect(() => {
    if (!hasPermissions || !analyserRef.current) return;

    const monitorAudio = () => {
      const level = detectVoiceActivity();

      // Update audio levels for visualization
      const time = Date.now() / 1000;
      const newLevels = Array(WAVE_BARS)
        .fill(0)
        .map((_, index) => {
          const wave = Math.sin(time * 3 + index * 0.5) * 0.3 + 0.7;
          const levelHeight = Math.max(
            WAVE_MIN_HEIGHT,
            Math.min(WAVE_MAX_HEIGHT, (level || 0.1) * WAVE_MAX_HEIGHT * wave),
          );
          return levelHeight;
        });

      setAudioLevels(newLevels);

      if (hasPermissions) {
        animationFrameRef.current = requestAnimationFrame(monitorAudio);
      }
    };

    monitorAudio();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [hasPermissions, detectVoiceActivity]);

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

  // Periodic cleanup of old chunks (every 2 seconds)
  useEffect(() => {
    if (!isRecording) return;

    const cleanupInterval = setInterval(() => {
      cleanOldChunks();
    }, 2000);

    return () => clearInterval(cleanupInterval);
  }, [isRecording, cleanOldChunks]);

  // Auto-start: Request permissions on mount
  useEffect(() => {
    requestPermissions();
  }, []);

  // Cleanup
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (animationFrameRef.current)
        cancelAnimationFrame(animationFrameRef.current);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

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
      setIsRequestingPermissions(true);
      setPermissionError(null);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: 320,
          height: 240,
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });

      streamRef.current = stream;
      await setupVideo(stream);

      // Setup audio context for voice detection
      audioContextRef.current = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;

      const source = audioContextRef.current.createMediaStreamSource(stream);
      source.connect(analyserRef.current);

      setHasPermissions(true);

      // Auto-start recording immediately after permissions granted
      await startRecordingInternal(stream);

      return true;
    } catch (error: any) {
      console.error("Permission error:", error);
      setPermissionError("Failed to get camera/microphone permissions");
      return false;
    } finally {
      setIsRequestingPermissions(false);
    }
  };

  const startRecordingInternal = async (stream?: MediaStream) => {
    const activeStream = stream || streamRef.current;

    if (!activeStream) {
      console.error("No stream available");
      return;
    }

    console.log("=== Starting Intelligent Recording ===");
    console.log(
      `📊 Rolling buffer: keeping last ${CAPTURE_WINDOW_SECONDS} seconds`,
    );

    // Clear chunks
    videoChunksRef.current = [];
    audioChunksRef.current = [];

    // VIDEO RECORDER with reduced quality
    const videoStream = new MediaStream(activeStream.getVideoTracks());
    mediaRecorderVideoRef.current = new MediaRecorder(videoStream, {
      mimeType: "video/webm;codecs=vp8",
      videoBitsPerSecond: 250000, // 250 kbps - very small
    });

    mediaRecorderVideoRef.current.ondataavailable = (event) => {
      if (event.data.size > 0) {
        // Add chunk with timestamp
        videoChunksRef.current.push({
          blob: event.data,
          timestamp: Date.now(),
        });
        console.log(
          `📹 Video chunk: ${(event.data.size / 1024).toFixed(2)} KB (total: ${videoChunksRef.current.length} chunks)`,
        );
      }
    };

    mediaRecorderVideoRef.current.start(1000); // Collect every 1 second

    // AUDIO RECORDER with reduced quality
    const audioStream = new MediaStream(activeStream.getAudioTracks());
    mediaRecorderAudioRef.current = new MediaRecorder(audioStream, {
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 32000, // 32 kbps - voice quality
    });

    mediaRecorderAudioRef.current.ondataavailable = (event) => {
      if (event.data.size > 0) {
        // Add chunk with timestamp
        audioChunksRef.current.push({
          blob: event.data,
          timestamp: Date.now(),
        });
        console.log(
          `🎤 Audio chunk: ${(event.data.size / 1024).toFixed(2)} KB (total: ${audioChunksRef.current.length} chunks)`,
        );
      }
    };

    mediaRecorderAudioRef.current.start(1000); // Collect every 1 second

    setIsRecording(true);
    setRecordingTimer(0);
  };

  const startRecording = async () => {
    if (!streamRef.current || !cameraReady) {
      const granted = await requestPermissions();
      if (!granted) return;
      return;
    }

    await startRecordingInternal();
  };

  const stopRecording = async () => {
    console.log("=== Stopping Recording ===");

    setIsRecording(false);

    if (timerRef.current) clearInterval(timerRef.current);
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

    if (mediaRecorderVideoRef.current?.state !== "inactive") {
      mediaRecorderVideoRef.current?.stop();
    }
    if (mediaRecorderAudioRef.current?.state !== "inactive") {
      mediaRecorderAudioRef.current?.stop();
    }

    continuousModeRef.current = false;
    setCurrentMode("idle");
    setAudioLevels(Array(WAVE_BARS).fill(WAVE_MIN_HEIGHT));
    setRecordingTimer(0);
  };

  const speakText = (text: string) => {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.85;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      utterance.lang = "en-US";

      utterance.onstart = () => setTtsSpeaking(true);
      utterance.onend = () => setTtsSpeaking(false);
      utterance.onerror = () => setTtsSpeaking(false);

      speechSynthesisRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    }
  };

  const stopTTS = () => {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      setTtsSpeaking(false);
    }
  };

  const simulateVoiceCommand = (command: string) => {
    processVoiceCommand(command);
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
              Intelligent AI Analyzer
            </h1>
            <p className="text-slate-400 mt-1">
              Always-On • Rolling {CAPTURE_WINDOW_SECONDS}s Buffer
            </p>
          </div>
          {recordings.length > 0 && (
            <div className="text-sm text-slate-400">
              {recordings.length} analyses
            </div>
          )}
        </div>

        {/* Current Mode Indicator */}
        <div className="bg-[#1A1538] rounded-2xl p-6 border border-slate-700">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-slate-400 mb-1">Current Mode</div>
              <div className="text-2xl font-bold text-violet-400">
                {currentMode.toUpperCase()}
              </div>
            </div>
            <Activity className="w-8 h-8 text-violet-400" />
          </div>
          <div className="mt-3 text-sm text-slate-300">
            {currentMode === "idle" && "Waiting for your voice commands..."}
            {currentMode === "single" && "Will analyze when you speak..."}
            {currentMode === "continuous" &&
              "Continuously analyzing for navigation..."}
          </div>
          <div className="mt-2 text-xs text-slate-500">
            Buffer: Last {CAPTURE_WINDOW_SECONDS}s •{" "}
            {videoChunksRef.current.length} video +{" "}
            {audioChunksRef.current.length} audio chunks
          </div>
        </div>

        {/* Camera Preview */}
        <div className="bg-[#1A1538] rounded-2xl p-6 border border-slate-700">
          <div className="flex items-center gap-2 mb-4">
            <Camera className="w-5 h-5 text-violet-400" />
            <span className="font-semibold">Live Preview</span>
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
                {isRecording && (
                  <div className="absolute top-4 left-4 flex items-center gap-2 bg-red-500/80 backdrop-blur-sm px-3 py-2 rounded-lg">
                    <div className="w-3 h-3 bg-white rounded-full animate-pulse" />
                    <span className="font-mono font-bold">
                      REC {recordingTimer}s
                    </span>
                  </div>
                )}
                {isProcessing && (
                  <div className="absolute top-4 right-4 bg-violet-500/80 backdrop-blur-sm px-4 py-2 rounded-lg flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span className="font-semibold">Analyzing...</span>
                  </div>
                )}
              </>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                <Camera className="w-16 h-16 text-slate-600" />
                <div className="text-slate-400 text-center">
                  <div className="font-semibold mb-1">
                    Camera Permissions Required
                  </div>
                  <div className="text-sm">
                    Enable camera and microphone to start
                  </div>
                </div>
                <button
                  onClick={requestPermissions}
                  disabled={isRequestingPermissions}
                  className="px-5 py-2.5 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-700 disabled:cursor-not-allowed rounded-xl font-semibold transition-colors"
                >
                  {isRequestingPermissions
                    ? "Requesting..."
                    : "Enable Camera & Mic"}
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
                {isUserSpeaking ? "User Speaking" : "Audio Monitor"}
              </span>
              {hasPermissions && (
                <span className="text-xs text-green-400 ml-2">
                  ● Always Active
                </span>
              )}
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
                className="w-full bg-gradient-to-t from-violet-600 to-purple-400 rounded-t-lg transition-all duration-75"
                style={{ height: `${level}px` }}
              />
            ))}
          </div>
        </div>

        {/* Voice Commands Demo */}
        <div className="bg-[#1A1538] rounded-2xl p-6 border border-slate-700">
          <div className="text-lg font-semibold mb-4">
            Voice Commands (Demo)
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <button
              onClick={() => simulateVoiceCommand("what's in front of me")}
              className="p-3 bg-[#1A1538] rounded-xl border border-slate-700 hover:bg-[#2A2548] transition-colors text-left"
            >
              <div className="font-semibold text-violet-400">
                "What's in front of me?"
              </div>
              <div className="text-xs text-slate-400 mt-1">Single analysis</div>
            </button>

            <button
              onClick={() =>
                simulateVoiceCommand("navigate me out of the room")
              }
              className="p-3 bg-[#1A1538] rounded-xl border border-slate-700 hover:bg-[#2A2548] transition-colors text-left"
            >
              <div className="font-semibold text-violet-400">
                "Navigate me out"
              </div>
              <div className="text-xs text-slate-400 mt-1">Continuous mode</div>
            </button>

            <button
              onClick={() => simulateVoiceCommand("describe my surroundings")}
              className="p-3 bg-[#1A1538] rounded-xl border border-slate-700 hover:bg-[#2A2548] transition-colors text-left"
            >
              <div className="font-semibold text-violet-400">
                "Describe surroundings"
              </div>
              <div className="text-xs text-slate-400 mt-1">Single analysis</div>
            </button>

            <button
              onClick={() => simulateVoiceCommand("stop")}
              className="p-3 bg-[#1A1538] rounded-xl border border-slate-700 hover:bg-[#2A2548] transition-colors text-left"
            >
              <div className="font-semibold text-violet-400">"Stop"</div>
              <div className="text-xs text-slate-400 mt-1">Go to idle</div>
            </button>
          </div>
        </div>

        {/* Current Analysis */}
        {currentAnalysis && (
          <div className="bg-gradient-to-br from-violet-900/30 to-purple-900/30 rounded-2xl p-6 border border-violet-500/30">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-5 h-5 text-violet-400" />
              <span className="font-semibold text-violet-300">
                Latest Analysis
              </span>
            </div>
            <div className="text-slate-100 leading-relaxed">
              {currentAnalysis}
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="flex gap-4">
          {!isRecording ? (
            <button
              onClick={startRecording}
              disabled={isProcessing || isRequestingPermissions}
              className="flex-1 py-4 rounded-xl font-bold text-lg transition-all bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
            >
              <Play className="w-6 h-6" />
              {isRequestingPermissions
                ? "REQUESTING PERMISSIONS..."
                : "START VOICE ANALYSIS"}
            </button>
          ) : (
            <div className="flex-1 py-4 rounded-xl font-bold text-lg bg-gradient-to-r from-green-600 to-emerald-600 flex items-center justify-center gap-3">
              <div className="w-3 h-3 bg-white rounded-full animate-pulse" />
              VOICE ANALYSIS ACTIVE ({recordingTimer}s)
            </div>
          )}

          <button
            onClick={
              ttsSpeaking ? stopTTS : () => speakText("Testing text to speech")
            }
            className="px-5 py-2.5 border-2 border-violet-500 text-violet-500 rounded-xl font-semibold hover:bg-violet-500/10 transition-colors"
          >
            {ttsSpeaking ? "Stop TTS" : "Test TTS"}
          </button>
        </div>

        {/* Recordings History */}
        {recordings.length > 0 && (
          <div className="bg-[#1A1538] rounded-2xl p-6 border border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-violet-400" />
                <span className="font-semibold">Analysis History</span>
              </div>
              <span className="text-sm text-slate-400">
                {recordings.length} analyses
              </span>
            </div>

            <div className="space-y-3">
              {recordings.map((recording, index) => (
                <div
                  key={index}
                  className="bg-[#0F0C1F] rounded-xl p-4 border border-slate-700"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-mono text-sm text-violet-400">
                      Analysis #{recordings.length - index} •{" "}
                      {recording.timestamp}
                    </div>
                    <div className="text-xs text-slate-500">
                      {formatBytes(recording.size)} •{" "}
                      {formatTime(recording.processingTime || 0)}
                    </div>
                  </div>

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
      </div>
    </div>
  );
}
