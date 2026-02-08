"use client";

import { useState, useEffect, useRef } from "react";
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
import { GoogleGenerativeAI } from "@google/generative-ai";
const genAI = new GoogleGenerativeAI(
  process.env.NEXT_PUBLIC_GEMINI_API_KEY || "",
);

const RECORDING_INTERVAL = 15000; // 5 seconds
const WAVE_BARS = 20;
const WAVE_MAX_HEIGHT = 60;
const WAVE_MIN_HEIGHT = 4;

interface Recording {
  timestamp: string;
  size: number;
  analysis?: string;
  processingTime?: number;
}

export default function Home() {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTimer, setRecordingTimer] = useState(0);
  const [cameraReady, setCameraReady] = useState(false);
  const [audioLevels, setAudioLevels] = useState<number[]>(
    Array(WAVE_BARS).fill(WAVE_MIN_HEIGHT),
  );
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [currentAnalysis, setCurrentAnalysis] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  const [hasPermissions, setHasPermissions] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [isRequestingPermissions, setIsRequestingPermissions] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderVideoRef = useRef<MediaRecorder | null>(null);
  const mediaRecorderAudioRef = useRef<MediaRecorder | null>(null);
  const videoChunksRef = useRef<Blob[]>([]);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const speechSynthesisRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Update the video element properties and handling
  const setupVideo = async (stream: MediaStream) => {
    if (!videoRef.current) return;

    videoRef.current.srcObject = stream;

    // Handle mobile-specific video playback
    const playVideo = async () => {
      try {
        await videoRef.current?.play();
        setCameraReady(true);
        console.log("✓ Video playback started successfully");
      } catch (error: any) {
        console.warn(
          "Auto-play failed, adding user interaction requirement:",
          error,
        );

        // On mobile, we often need user interaction to play video
        setCameraReady(true); // Still mark as ready for UI

        // Show a play button overlay for mobile
        if (error.name === "NotAllowedError") {
          console.log("Waiting for user interaction to play video");
        }
      }
    };

    // Try to play with metadata loaded
    videoRef.current.onloadedmetadata = () => {
      console.log("Video metadata loaded, attempting to play");
      playVideo();
    };

    // Also try immediately (in case metadata is already loaded)
    if (videoRef.current.readyState >= 1) {
      playVideo();
    }
  };

  // Request camera and microphone permissions
  // Replace the current requestPermissions function with this improved version:
  const requestPermissions = async () => {
    try {
      setIsRequestingPermissions(true);
      setPermissionError(null);

      // Check if we're on mobile
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      console.log("Device:", isMobile ? "Mobile" : "Desktop");

      // Different constraints for mobile vs desktop
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: { ideal: "environment" }, // Use back camera on mobile
          width: isMobile ? { ideal: 640 } : { ideal: 1280 },
          height: isMobile ? { ideal: 480 } : { ideal: 720 },
          frameRate: { ideal: 30 },
          // On mobile, prefer H.264 if possible
          ...(isMobile && {
            advanced: [{ codec: "video/h264" } as any],
          }),
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100,
          channelCount: 1,
          autoGainControl: true,
        },
      };

      // On iOS, we need to handle permission flow differently
      if (isMobile) {
        // First check if we're on iOS
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

        if (isIOS) {
          console.log("iOS device detected - using specific handling");
          // iOS has stricter autoplay policies
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      // Setup video with mobile-friendly approach
      await setupVideo(stream);

      // Setup audio visualization only if we have audio
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        try {
          // On mobile, we need user interaction to create AudioContext
          audioContextRef.current = new (window.AudioContext ||
            (window as any).webkitAudioContext)();
          analyserRef.current = audioContextRef.current.createAnalyser();
          analyserRef.current.fftSize = 256;

          const source =
            audioContextRef.current.createMediaStreamSource(stream);
          source.connect(analyserRef.current);
        } catch (audioError) {
          console.warn("Audio context failed on mobile:", audioError);
        }
      }

      setHasPermissions(true);
      return true;
    } catch (error: any) {
      console.error("Permission error:", error);

      let errorMessage = "Camera and microphone permissions are required";

      // Specific mobile error messages
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

      if (isMobile && error.name === "NotAllowedError") {
        errorMessage =
          "Please enable camera access in your device settings and reload the page";
      } else if (error.name === "NotFoundError") {
        errorMessage =
          "No camera found. Make sure you're using a device with a camera";
      } else if (error.name === "NotReadableError") {
        errorMessage =
          "Camera is already in use by another app. Please close other camera apps";
      } else if (error.name === "OverconstrainedError") {
        errorMessage =
          "Your device doesn't support the requested camera settings. Trying simpler settings...";

        // Try again with simpler constraints
        return await requestPermissionsWithSimpleConstraints();
      }

      setPermissionError(errorMessage);
      setHasPermissions(false);
      return false;
    } finally {
      setIsRequestingPermissions(false);
    }
  };

  // Audio visualization
  const visualizeAudio = () => {
    if (!analyserRef.current || !isRecording) return;

    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyserRef.current.getByteFrequencyData(dataArray);

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
    animationFrameRef.current = requestAnimationFrame(visualizeAudio);
  };

  // Start recording
  const startRecording = async () => {
    if (!streamRef.current || !cameraReady) {
      const granted = await requestPermissions();
      if (!granted) return;
    }

    console.log("=== Starting Recording ===");

    // Reset chunks
    videoChunksRef.current = [];
    audioChunksRef.current = [];

    // Start video recording
    try {
      if (streamRef.current) {
        const videoStream = new MediaStream(streamRef.current.getVideoTracks());

        mediaRecorderVideoRef.current = new MediaRecorder(videoStream, {
          mimeType: "video/webm;codecs=vp9",
        });

        mediaRecorderVideoRef.current.ondataavailable = (event) => {
          if (event.data.size > 0) {
            videoChunksRef.current.push(event.data);
          }
        };

        mediaRecorderVideoRef.current.start();
        console.log("✓ Video recording started");
      }
    } catch (error) {
      console.error("Failed to start video recording:", error);
    }

    // Start audio recording
    try {
      if (streamRef.current) {
        const audioStream = new MediaStream(streamRef.current.getAudioTracks());

        mediaRecorderAudioRef.current = new MediaRecorder(audioStream, {
          mimeType: "audio/webm;codecs=opus",
        });

        mediaRecorderAudioRef.current.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorderAudioRef.current.start();
        console.log("✓ Audio recording started");
      }
    } catch (error) {
      console.error("Failed to start audio recording:", error);
    }

    setIsRecording(true);
    setRecordingTimer(0);

    // Start audio visualization
    visualizeAudio();

    // Start timer
    let timer = 0;
    timerRef.current = setInterval(() => {
      timer += 1;
      setRecordingTimer(timer);

      if (timer % (RECORDING_INTERVAL / 1000) === 0) {
        console.log(
          `\n⏰ ${RECORDING_INTERVAL / 1000}s interval reached - processing recording`,
        );
        processRecording();
      }
    }, 1000);

    console.log("✓ Timer started");
  };

  // Stop recording
  const stopRecording = async () => {
    console.log("=== Stopping Recording ===");
    setIsRecording(false);

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (
      mediaRecorderVideoRef.current &&
      mediaRecorderVideoRef.current.state !== "inactive"
    ) {
      mediaRecorderVideoRef.current.stop();
    }

    if (
      mediaRecorderAudioRef.current &&
      mediaRecorderAudioRef.current.state !== "inactive"
    ) {
      mediaRecorderAudioRef.current.stop();
    }

    setAudioLevels(Array(WAVE_BARS).fill(WAVE_MIN_HEIGHT));
    setRecordingTimer(0);
  };

  // Convert blob to base64
  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result as string;
        // Remove data URL prefix
        const base64 = base64String.split(",")[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // Restart recordings
  const restartRecordings = async () => {
    console.log("\n=== Restarting Recordings ===");

    videoChunksRef.current = [];
    audioChunksRef.current = [];

    // Restart video
    try {
      if (streamRef.current && mediaRecorderVideoRef.current) {
        const videoStream = new MediaStream(streamRef.current.getVideoTracks());
        mediaRecorderVideoRef.current = new MediaRecorder(videoStream, {
          mimeType: "video/webm;codecs=vp9",
        });

        mediaRecorderVideoRef.current.ondataavailable = (event) => {
          if (event.data.size > 0) {
            videoChunksRef.current.push(event.data);
          }
        };

        mediaRecorderVideoRef.current.start();
        console.log("✓ Video restarted");
      }
    } catch (error) {
      console.error("Error restarting video:", error);
    }

    // Restart audio
    try {
      if (streamRef.current && mediaRecorderAudioRef.current) {
        const audioStream = new MediaStream(streamRef.current.getAudioTracks());
        mediaRecorderAudioRef.current = new MediaRecorder(audioStream, {
          mimeType: "audio/webm;codecs=opus",
        });

        mediaRecorderAudioRef.current.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorderAudioRef.current.start();
        console.log("✓ Audio restarted");
      }
    } catch (error) {
      console.error("Error restarting audio:", error);
    }
  };

  // Process recording and send to Gemini
  const processRecording = async () => {
    const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;

    if (!apiKey || apiKey === "YOUR_GEMINI_API_KEY_HERE") {
      alert("Please set your Gemini API key in .env.local");
      return;
    }

    try {
      setIsProcessing(true);
      const startTime = Date.now();

      console.log("\n=== Processing Recording ===");

      // Stop current recording to capture data
      if (
        mediaRecorderVideoRef.current &&
        mediaRecorderVideoRef.current.state !== "inactive"
      ) {
        mediaRecorderVideoRef.current.stop();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (
        mediaRecorderAudioRef.current &&
        mediaRecorderAudioRef.current.state !== "inactive"
      ) {
        mediaRecorderAudioRef.current.stop();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Get video and audio blobs
      const videoBlob =
        videoChunksRef.current.length > 0
          ? new Blob(videoChunksRef.current, { type: "video/webm" })
          : null;

      const audioBlob =
        audioChunksRef.current.length > 0
          ? new Blob(audioChunksRef.current, { type: "audio/webm" })
          : null;

      console.log(
        "Video blob:",
        videoBlob ? `${(videoBlob.size / 1024).toFixed(2)} KB` : "N/A",
      );
      console.log(
        "Audio blob:",
        audioBlob ? `${(audioBlob.size / 1024).toFixed(2)} KB` : "N/A",
      );

      if (!videoBlob && !audioBlob) {
        console.error("❌ No media data available");
        alert("No audio or video data was captured. Please try again.");
        setIsProcessing(false);
        if (isRecording) await restartRecordings();
        return;
      }

      // Restart recordings if still in recording mode
      if (isRecording) {
        await restartRecordings();
      }

      // Convert to base64
      const videoBase64 = videoBlob ? await blobToBase64(videoBlob) : null;
      const audioBase64 = audioBlob ? await blobToBase64(audioBlob) : null;

      console.log(
        "Video Base64:",
        videoBase64 ? `${(videoBase64.length / 1024).toFixed(2)} KB` : "N/A",
      );
      console.log(
        "Audio Base64:",
        audioBase64 ? `${(audioBase64.length / 1024).toFixed(2)} KB` : "N/A",
      );

      // Send to Gemini
      const analysis = await analyzeWithGemini(videoBase64, audioBase64);

      const processingTime = Date.now() - startTime;

      // Add to recordings history
      const newRecording: Recording = {
        timestamp: new Date().toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
        size: (videoBlob?.size || 0) + (audioBlob?.size || 0),
        analysis: analysis.substring(0, 100) + "...",
        processingTime,
      };

      setRecordings((prev) => [newRecording, ...prev.slice(0, 9)]);

      console.log("✓ Analysis completed in", processingTime, "ms\n");
    } catch (error) {
      console.error("Error processing recording:", error);
      alert(
        "Failed to analyze recording: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    } finally {
      setIsProcessing(false);
    }
  };

  // Analyze with Gemini
  const analyzeWithGemini = async (
    videoBase64: string | null,
    audioBase64: string | null,
  ): Promise<string> => {
    try {
      console.log("\n=== Gemini API Request ===");
      console.log(
        "Video data:",
        videoBase64
          ? `✓ Present (${Math.round(videoBase64.length / 1024)} KB)`
          : "✗ Missing",
      );
      console.log(
        "Audio data:",
        audioBase64
          ? `✓ Present (${Math.round(audioBase64.length / 1024)} KB)`
          : "✗ Missing",
      );

      if (!videoBase64 && !audioBase64) {
        throw new Error("No media data to send to Gemini");
      }

      // Check API key
      if (
        !process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
        process.env.NEXT_PUBLIC_GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE"
      ) {
        throw new Error("Please set your Gemini API key in .env.local");
      }

      const parts: any[] = [
        {
          text: `
You are an assistive navigation guide for a visually impaired user.
You receive live video and audio from the user’s surroundings.
Identify immediate obstacles, directions, moving objects, and important sounds.
Respond with clear, calm, actionable guidance in 1–2 short lines only.
Do not explain your reasoning.
Prioritize safety, orientation, and simple directions (left, right, forward, stop).
`,
        },
      ];

      // Add video if available
      if (videoBase64) {
        // Validate video base64 string
        if (!videoBase64.startsWith("/9j/") && !videoBase64.includes("AAAA")) {
          console.warn("Video base64 might be malformed");
        }

        parts.push({
          inlineData: {
            mimeType: "video/mp4",
            data: videoBase64,
          },
          mediaResolution: {
            level: "media_resolution_high",
          },
        });
        console.log("✓ Video data added to request");
      }

      // Add audio if available
      if (audioBase64) {
        // Validate audio base64 string
        if (!audioBase64.includes("SUQz")) {
          console.warn("Audio base64 might be malformed");
        }

        parts.push({
          inlineData: {
            mimeType: "audio/mp4",
            data: audioBase64,
          },
          mediaResolution: {
            level: "media_resolution_high",
          },
        });
        console.log("✓ Audio data added to request");
      }

      console.log(`Sending request to Gemini with ${parts.length} parts...`);

      // Initialize the model
      const model = genAI.getGenerativeModel({
        model: "gemini-3-flash-preview", // Using a more stable model
      });

      // Get single concise response from Gemini
      const result = await model.generateContent({
        contents: [
          {
            parts: parts,
          },
        ],
      });

      const responseText = result.response.text() || "";

      console.log("✓ Response received:", responseText);

      // Clean up the response if needed
      const cleanResponse = responseText
        .replace(/^["']|["']$/g, "") // Remove quotes if present
        .replace(/\s+/g, " ") // Normalize whitespace
        .replace(/\.$/g, "") // Remove trailing period
        .trim();

      console.log("✓ Cleaned response:", cleanResponse);

      // Update display
      setCurrentAnalysis(cleanResponse);

      // Speak the concise analysis
      if (cleanResponse) {
        speakText(cleanResponse);
      }

      return cleanResponse;
    } catch (error: any) {
      console.error("❌ Gemini API error:", error);
      console.error("Error details:", error.message);

      // Provide more specific error messages
      let errorMessage = "Failed to analyze with Gemini";

      if (error.message?.includes("API key not valid")) {
        errorMessage =
          "Invalid Gemini API key. Please check your .env.local file";
      } else if (error.message?.includes("quota")) {
        errorMessage = "API quota exceeded. Please check your Gemini API usage";
      } else if (
        error.message?.includes("video format") ||
        error.message?.includes("mimeType")
      ) {
        errorMessage =
          "Unsupported video format. Try changing video codec to H.264";
      } else if (error.message) {
        errorMessage = `Gemini API error: ${error.message.substring(0, 100)}`;
      }

      throw new Error(errorMessage);
    }
  };

  // Text to speech
  const speakText = (text: string) => {
    if ("speechSynthesis" in window) {
      // Stop any ongoing speech
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
  // Add this function to check permissions on component mount
  const checkExistingPermissions = async () => {
    try {
      // Check if we already have permissions
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasVideo = devices.some(
        (device) => device.kind === "videoinput" && device.label,
      );
      const hasAudio = devices.some(
        (device) => device.kind === "audioinput" && device.label,
      );

      if (hasVideo && hasAudio) {
        // We might already have permissions
        console.log("Devices already have permissions:", devices);
        return true;
      }
      return false;
    } catch (error) {
      console.error("Error checking existing permissions:", error);
      return false;
    }
  };

  // Replace the current useEffect with this:
  useEffect(() => {
    // Check for existing permissions on mount
    const initPermissions = async () => {
      if (typeof window !== "undefined" && navigator.mediaDevices) {
        const hasExistingPermissions = await checkExistingPermissions();
        if (hasExistingPermissions) {
          // Try to get the stream immediately
          const granted = await requestPermissions();
          if (!granted) {
            console.log("Existing permissions but failed to get stream");
          }
        }
      }
    };

    initPermissions();

    return () => {
      // Cleanup
      if (timerRef.current) clearInterval(timerRef.current);
      if (animationFrameRef.current)
        cancelAnimationFrame(animationFrameRef.current);
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

  // Initialize on mount
  // useEffect(() => {
  //   return () => {
  //     // Cleanup
  //     if (timerRef.current) clearInterval(timerRef.current);
  //     if (animationFrameRef.current)
  //       cancelAnimationFrame(animationFrameRef.current);
  //     if (streamRef.current) {
  //       streamRef.current.getTracks().forEach((track) => track.stop());
  //     }
  //     if (audioContextRef.current) {
  //       audioContextRef.current.close();
  //     }
  //     if ("speechSynthesis" in window) {
  //       window.speechSynthesis.cancel();
  //     }
  //   };
  // }, []);

  const nextCaptureIn = isRecording
    ? RECORDING_INTERVAL / 1000 - (recordingTimer % (RECORDING_INTERVAL / 1000))
    : RECORDING_INTERVAL / 1000;

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
    <div className="min-h-screen bg-[#0F0B21] text-slate-50">
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <header className="flex items-center justify-between pt-8 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-violet-500/10 border-2 border-violet-500 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-violet-500" />
            </div>
            <div>
              <p className="text-sm text-slate-400">Gemini AI Analyzer</p>
              <h1 className="text-base font-semibold">
                Real-time Video/Audio Analysis
              </h1>
            </div>
          </div>

          <button
            onClick={() => {
              if (recordings.length > 0) {
                setRecordings([]);
                alert("All recordings cleared");
              }
            }}
            className="relative w-11 h-11 rounded-full bg-[#1A1538] flex items-center justify-center hover:bg-[#2A2548] transition-colors"
          >
            <Activity className="w-6 h-6" />
            {recordings.length > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 bg-violet-500 rounded-full text-xs font-bold flex items-center justify-center">
                {recordings.length}
              </span>
            )}
          </button>
        </header>

        {/* Camera Preview */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Live Preview</h2>

          <div className="relative rounded-2xl overflow-hidden bg-[#1A1538] border border-slate-700">
            {hasPermissions ? (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-64 object-cover"
                />

                {isRecording && (
                  <div className="absolute top-4 right-4 flex items-center gap-2 bg-red-600/90 px-3 py-1.5 rounded-full">
                    <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                    <span className="text-sm font-bold">
                      REC {recordingTimer}s
                    </span>
                  </div>
                )}

                {isProcessing && (
                  <div className="absolute bottom-4 left-4 flex items-center gap-2 bg-violet-500/90 px-3 py-1.5 rounded-full">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm font-semibold">
                      Analyzing with Gemini...
                    </span>
                  </div>
                )}

                <div className="flex justify-around py-3 bg-black/30 border-t border-slate-700">
                  <div className="flex items-center gap-2">
                    <Camera
                      className={`w-4 h-4 ${cameraReady ? "text-emerald-400" : "text-slate-500"}`}
                    />
                    <span className="text-xs text-slate-400">
                      {cameraReady ? "Ready" : "..."}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Mic
                      className={`w-4 h-4 ${isRecording ? "text-emerald-400" : "text-red-400"}`}
                    />
                    <span className="text-xs text-slate-400">
                      {isRecording ? "Recording" : "Ready"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Sparkles
                      className={`w-4 h-4 ${isProcessing ? "text-violet-500" : "text-slate-500"}`}
                    />
                    <span className="text-xs text-slate-400">
                      {isProcessing ? "Analyzing" : "Ready"}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <div className="h-64 flex flex-col items-center justify-center gap-4">
                <Camera className="w-16 h-16 text-slate-600" />
                <p className="text-base font-semibold">Permissions Required</p>
                <button
                  onClick={requestPermissions}
                  className="px-6 py-2.5 bg-violet-500 hover:bg-violet-600 rounded-xl font-semibold transition-colors"
                >
                  Grant Permissions
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Audio Visualization */}
        <section className="space-y-3">
          <div className="flex items-center justify-center gap-3">
            <Activity
              className={`w-6 h-6 ${isRecording ? "text-violet-500" : "text-slate-500"}`}
            />
            <h2 className="text-base font-semibold">
              {isRecording ? "Live Audio Levels" : "Audio Monitor"}
            </h2>
            {ttsSpeaking ? (
              <Volume2 className="w-6 h-6 text-violet-500" />
            ) : (
              <VolumeX className="w-6 h-6 text-slate-500" />
            )}
          </div>

          <div className="flex items-end justify-between h-20 px-2.5 py-2.5 bg-[#1A1538] rounded-2xl border border-slate-700">
            {audioLevels.map((level, index) => (
              <div
                key={index}
                className={`w-2 rounded transition-all duration-100 ${isRecording ? "bg-violet-400/70" : "bg-slate-600"}`}
                style={{
                  height: `${level}px`,
                  opacity: 0.7 + Math.sin(index * 0.5) * 0.3,
                }}
              />
            ))}
          </div>

          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-400">Status:</span>
              <span
                className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm font-semibold ${isRecording ? "bg-emerald-400/20 text-emerald-400" : "bg-slate-600/20 text-slate-400"}`}
              >
                <div
                  className={`w-2 h-2 rounded-full ${isRecording ? "bg-emerald-400" : "bg-slate-400"}`}
                />
                {isRecording ? "Recording" : "Ready"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-400">Interval:</span>
              <span className="text-sm font-semibold text-violet-500">
                {RECORDING_INTERVAL / 1000}s
              </span>
            </div>
          </div>
        </section>

        {/* Current Analysis */}
        {currentAnalysis && (
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Current Analysis</h2>
            <div className="flex items-start gap-3 bg-[#1A1538] rounded-2xl p-4 border border-slate-700">
              <Sparkles className="w-6 h-6 text-violet-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm leading-relaxed">{currentAnalysis}</p>
            </div>
          </section>
        )}

        {/* Controls */}
        <section className="space-y-4">
          <button
            onClick={isRecording ? stopRecording : startRecording}
            disabled={!hasPermissions || isProcessing}
            className={`w-full py-5 rounded-2xl font-bold text-lg transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
              isRecording
                ? "bg-[#1A1538] hover:bg-[#2A2548]"
                : "bg-violet-500 hover:bg-violet-600 shadow-lg shadow-violet-500/30"
            }`}
          >
            {isRecording ? (
              <span className="flex items-center justify-center gap-2">
                <Square className="w-5 h-5" />
                STOP RECORDING ({recordingTimer}s)
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2">
                <Play className="w-5 h-5" />
                START AUTO-ANALYSIS
              </span>
            )}
          </button>

          <div className="flex items-center justify-center gap-2 text-sm text-violet-400">
            <Clock className="w-5 h-5" />
            <span>
              {isRecording
                ? `Next analysis in: ${nextCaptureIn}s`
                : `Auto-analysis every ${RECORDING_INTERVAL / 1000}s`}
            </span>
          </div>

          <div className="flex gap-3 justify-center">
            <button
              onClick={
                ttsSpeaking
                  ? stopTTS
                  : () =>
                      speakText("This is a test of the text to speech system.")
              }
              className="px-5 py-2.5 border-2 border-violet-500 text-violet-500 rounded-xl font-semibold hover:bg-violet-500/10 transition-colors"
            >
              {ttsSpeaking ? "Stop TTS" : "Test TTS"}
            </button>
          </div>
        </section>

        {/* Recordings History */}
        {recordings.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Analysis History</h2>
              <span className="text-sm text-slate-400 font-medium">
                {recordings.length} records
              </span>
            </div>

            <div className="bg-[#1A1538] rounded-xl border border-slate-700 overflow-hidden divide-y divide-slate-700">
              {recordings.map((recording, index) => (
                <button
                  key={index}
                  onClick={() => {
                    if (recording.analysis) {
                      alert(
                        `Analysis ${recordings.length - index}\n\n${recording.analysis}`,
                      );
                    }
                  }}
                  className="w-full flex items-center gap-3 p-4 hover:bg-[#2A2548] transition-colors text-left"
                >
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center ${
                      index === 0 ? "bg-violet-500/20" : "bg-slate-700"
                    }`}
                  >
                    <Sparkles
                      className={`w-5 h-5 ${index === 0 ? "text-violet-500" : "text-slate-500"}`}
                    />
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold">
                      Analysis #{recordings.length - index} •{" "}
                      {recording.timestamp}
                    </p>
                    <p className="text-xs text-slate-400">
                      {formatBytes(recording.size)} •{" "}
                      {recording.processingTime
                        ? formatTime(recording.processingTime)
                        : "Processing..."}
                    </p>
                    {recording.analysis && (
                      <p className="text-xs text-violet-400 italic mt-1 line-clamp-2">
                        {recording.analysis}
                      </p>
                    )}
                  </div>

                  <svg
                    className="w-5 h-5 text-slate-500 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* System Status */}
        <section>
          <div className="flex items-start gap-3 bg-[#1A1538] rounded-2xl p-4 border border-slate-700">
            <Sparkles className="w-6 h-6 text-violet-500 flex-shrink-0" />
            <div className="flex-1">
              <h3 className="text-base font-semibold mb-3">System Status</h3>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-black/20 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-400 mb-1">Gemini API</p>
                  <p
                    className={`text-xs font-bold ${
                      process.env.NEXT_PUBLIC_GEMINI_API_KEY &&
                      process.env.NEXT_PUBLIC_GEMINI_API_KEY !==
                        "YOUR_GEMINI_API_KEY_HERE"
                        ? "text-emerald-400"
                        : "text-red-400"
                    }`}
                  >
                    {process.env.NEXT_PUBLIC_GEMINI_API_KEY &&
                    process.env.NEXT_PUBLIC_GEMINI_API_KEY !==
                      "YOUR_GEMINI_API_KEY_HERE"
                      ? "CONNECTED"
                      : "SET API KEY"}
                  </p>
                </div>

                <div className="bg-black/20 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-400 mb-1">Camera</p>
                  <p
                    className={`text-xs font-bold ${cameraReady ? "text-emerald-400" : "text-slate-400"}`}
                  >
                    {cameraReady ? "READY" : "..."}
                  </p>
                </div>

                <div className="bg-black/20 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-400 mb-1">Microphone</p>
                  <p
                    className={`text-xs font-bold ${hasPermissions ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {hasPermissions ? "READY" : "PERMISSION"}
                  </p>
                </div>

                <div className="bg-black/20 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-400 mb-1">Interval</p>
                  <p className="text-xs font-bold text-violet-400">
                    {RECORDING_INTERVAL / 1000}s
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Instructions */}
        <section className="space-y-4">
          <h2 className="text-base font-semibold">How It Works</h2>

          <div className="space-y-3">
            {[
              "Start recording to begin automatic analysis",
              `Every ${RECORDING_INTERVAL / 1000} seconds, video/audio is sent to Gemini AI`,
              "Gemini streams analysis in real-time as it processes",
              "Results are spoken via streaming TTS and saved to history",
            ].map((text, index) => (
              <div key={index} className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-violet-500 flex items-center justify-center flex-shrink-0">
                  <span className="text-sm font-bold">{index + 1}</span>
                </div>
                <p className="text-sm text-slate-400">{text}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="h-8" />
      </div>
    </div>
  );
}
