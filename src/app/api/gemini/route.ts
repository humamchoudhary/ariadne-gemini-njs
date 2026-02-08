import { NextRequest, NextResponse } from "next/server";
import {
  GoogleGenAI,
  MediaResolution,
  ThinkingLevel,
  createUserContent,
  createPartFromUri,
} from "@google/genai";

const genAI = new GoogleGenAI({ apiVersion: "v1alpha" });

const responseSchema = {
  type: "object",
  properties: {
    analysis: {
      type: "string",
      description:
        "The analysis of the video/audio content for visually impaired user",
    },
    mode: {
      type: "string",
      enum: ["idle", "continuous", "single"],
      description: "The mode Gemini should operate in after this response",
    },
    reason: {
      type: "string",
      description: "Brief explanation of why this mode was chosen",
    },
    shouldRespond: {
      type: "boolean",
      description: "Whether this response should be spoken to the user via TTS",
    },
    transcription: {
      type: "string",
      description: "Audio transcription of what the user said",
    },
  },
  required: ["analysis", "mode", "shouldRespond", "transcription"],
};

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const videoFile = formData.get("video") as File | null;
    const audioFile = formData.get("audio") as File | null;
    const userIntent = formData.get("intent") as string | null;
    const currentMode = formData.get("currentMode") as string | null;

    console.log("📥 Received request:", {
      hasVideo: !!videoFile,
      hasAudio: !!audioFile,
      videoSize: videoFile?.size,
      audioSize: audioFile?.size,
      intent: userIntent,
      mode: currentMode,
    });

    if (!videoFile && !audioFile) {
      return NextResponse.json(
        { success: false, error: "No video or audio data provided" },
        { status: 400 },
      );
    }

    const systemPrompt = `You are an AI assistant for visually impaired users. Analyze the provided video and audio content.

Current mode: ${currentMode || "idle"}
User intent: ${userIntent || "general awareness"}

CRITICAL: Respond with a JSON object matching this schema:
{
  "analysis": "Your analysis here - be concise and actionable",
  "mode": "idle|continuous|single", 
  "reason": "Brief explanation of mode choice",
  "shouldRespond": true|false,
  "transcription": "Audio transcription of what user said"
}

MODES:
- "idle": User is not actively navigating or asking questions. Keep responses minimal.
- "continuous": User is actively navigating (like "navigate me out"). Keep analyzing until they reach destination.  
- "single": User asked a specific question (like "what's in front of me"). Answer and go back to idle.

SHOULD RESPOND RULES:
- Set "shouldRespond" to TRUE when:
  * User explicitly asked a question
  * There's a safety hazard (obstacles, stairs, moving objects)
  * Significant change in the environment
  * User is in continuous mode and needs navigation guidance
  
- Set "shouldRespond" to FALSE when:
  * Background noise or no clear question
  * Scene hasn't changed significantly
  * Nothing important to report
  * User is in idle mode and no questions were asked

RESPONSE RULES:
1. Prioritize safety - identify obstacles, moving objects, stairs
2. Give clear directional guidance: left, right, forward, stop
3. Be extremely concise - maximum 2 short sentences
4. First transcribe what the user said, then analyze the scene
5. If no clear speech detected, set transcription to empty string`;

    // Upload files in parallel to File API
    console.log("📤 Uploading files to Gemini File API...");
    const uploadStartTime = Date.now();

    const uploadPromises: Promise<any>[] = [];

    if (videoFile && videoFile.size > 0) {
      uploadPromises.push(
        genAI.files
          .upload({
            file: videoFile,
            config: { mimeType: "video/webm" },
          })
          .then((file) => {
            console.log(
              `✅ Video uploaded: ${file.uri} (${((Date.now() - uploadStartTime) / 1000).toFixed(2)}s)`,
            );
            return { type: "video", file };
          }),
      );
    }

    if (audioFile && audioFile.size > 0) {
      uploadPromises.push(
        genAI.files
          .upload({
            file: audioFile,
            config: { mimeType: "audio/webm" },
          })
          .then((file) => {
            console.log(
              `✅ Audio uploaded: ${file.uri} (${((Date.now() - uploadStartTime) / 1000).toFixed(2)}s)`,
            );
            return { type: "audio", file };
          }),
      );
    }

    if (uploadPromises.length === 0) {
      return NextResponse.json(
        { success: false, error: "No valid media files" },
        { status: 400 },
      );
    }

    // Wait for all uploads to complete in parallel
    const uploadedFiles = await Promise.all(uploadPromises);
    console.log(
      `✅ All files uploaded in ${((Date.now() - uploadStartTime) / 1000).toFixed(2)}s`,
    );

    // Build content parts with uploaded file URIs
    const contentParts: any[] = [];

    for (const { file } of uploadedFiles) {
      var looping = true;
      console.log(file);
      while (looping) {
        console.log(file.state);
        switch (file.state) {
          case "ACTIVE":
            looping = true;
            break;

          case "FAILED":
            throw new Error(`Failed to upload ${file}`);
        }
      }

      console.log(file.state);
      contentParts.push(createPartFromUri(file.uri, file.mimeType));
    }

    contentParts.push(systemPrompt);

    // Generate content using uploaded files
    let result;
    try {
      console.log("🤖 Generating content with Gemini...");
      const generateStartTime = Date.now();

      result = await genAI.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: createUserContent(contentParts),
        config: {
          responseMimeType: "application/json",
          responseSchema: responseSchema,
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.MINIMAL,
          },
        },
      });

      console.log(
        `✅ Content generated in ${((Date.now() - generateStartTime) / 1000).toFixed(2)}s`,
      );
    } catch (apiError: any) {
      console.error("❌ Gemini API error:", apiError);

      let errorMessage = "Gemini API error";
      if (apiError.message?.includes("INVALID_ARGUMENT")) {
        errorMessage =
          "Invalid media format - please check video/audio encoding";
      } else if (apiError.message?.includes("QUOTA_EXCEEDED")) {
        errorMessage = "API quota exceeded - please try again later";
      } else if (apiError.message) {
        errorMessage = apiError.message;
      }

      return NextResponse.json(
        {
          success: false,
          error: errorMessage,
          details: apiError.message || "Unknown API error",
        },
        { status: 500 },
      );
    } finally {
      // Clean up uploaded files (optional - files auto-delete after 48 hours)
      try {
        await Promise.all(
          uploadedFiles.map(({ file }) => genAI.files.delete(file.name)),
        );
        console.log("🗑️ Uploaded files cleaned up");
      } catch (cleanupError) {
        console.warn("⚠️ File cleanup failed (non-critical):", cleanupError);
      }
    }

    const responseText = result.text;
    console.log("📨 Gemini response:", responseText);

    // Parse the structured JSON response
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(responseText || "{}");

      if (!parsedResponse.analysis || !parsedResponse.mode) {
        throw new Error("Missing required fields in response");
      }

      console.log("✅ Response parsed successfully");
    } catch (parseError) {
      console.error("❌ Failed to parse response:", parseError);

      parsedResponse = {
        analysis: responseText?.substring(0, 200) || "Unable to analyze",
        mode: "single",
        reason: "Fallback due to parse error",
        shouldRespond: true,
        transcription: "",
      };
    }

    return NextResponse.json({
      success: true,
      data: parsedResponse,
    });
  } catch (error) {
    console.error("❌ Server error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    model: "gemini-3-flash-preview",
    method: "File API (parallel upload)",
  });
}
