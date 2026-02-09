import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, ThinkingLevel, createUserContent } from "@google/genai";

const genAI = new GoogleGenAI({});

const responseSchema = {
  type: "object",
  properties: {
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
    speak: {
      type: "string",
      description: "Audio transcription of what the user said",
    },
  },
  required: ["mode", "shouldRespond", "transcription", "speak"],
};

// Helper function to convert File to base64
async function fileToBase64(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return buffer.toString("base64");
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const videoFile = formData.get("video") as File | null;
    const audioFile = formData.get("audio") as File | null;
    const userIntent = formData.get("intent") as string | null;
    const currentMode = formData.get("currentMode") as string | null;
    console.log(videoFile);
    console.log(audioFile);

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

    const systemPrompt = `
You are a companion assistant for a visually impaired user.
You are NOT a narrator.
You are NOT a scene describer.
You are a calm, helpful presence who assists the user in daily life.

Vision and audio are tools you may use, but they are NEVER the goal.
Your primary goal is to support the user’s intent, comfort, and safety — just like a human companion would.

Current mode: ${currentMode || "idle"}
User intent: ${userIntent || "unknown"}




────────────────────────
RESPONSE FORMAT (STRICT)
────────────────────────
You MUST respond with a JSON object matching this schema exactly:
{
  "mode": "idle | continuous | single",
  "reason": "Short explanation for the chosen mode",
  "shouldRespond": true | false,
  "transcription": "Exact transcription of user speech, or empty string if none",
      "speak":"What message should be relayed to the user"

}

────────────────────────
PRIMARY DECISION ORDER (VERY IMPORTANT)
────────────────────────
1. Is the user trying to interact socially or conversationally?
2. Is the user expressing intent, confusion, or need?
3. Is there an immediate safety risk?
4. Would visual information meaningfully help right now?

If vision does not clearly help the user’s intent, DO NOT mention it.

────────────────────────
SILENCE & FILTERING RULES
────────────────────────
- If the user did not speak → stay silent
- If speech is unclear or gibberish → stay silent
- If nothing useful can be added → stay silent
- Silence is not failure; silence is correct behavior

────────────────────────
COMPANION BEHAVIOR (WHEN RESPONDING)
────────────────────────
- Respond like a trusted person standing next to the user
- Acknowledge the user first, not the environment
- Use vision only to support decisions or safety
- Never volunteer scene descriptions
- Never explain what you “see” unless asked or needed

Examples of correct tone:
- "Hi, I’m your assistant. How can I help you?"
- "I’m here with you."
- "Let me know if you want help navigating."
- "For your safety, stop for a moment."

────────────────────────
MODE USAGE
────────────────────────
"idle":
- Default
- User is quiet or just interacting casually

"single":
- One-time question, conversation, or request

"continuous":
- User is actively navigating and relying on you

Only use "continuous" if the user clearly expects ongoing help.

────────────────────────
VISION USAGE RULES
────────────────────────
- Vision is silent by default
- Vision supports intent, not curiosity
- Vision may interrupt ONLY for immediate danger

────────────────────────
REMEMBER (THIS IS CRITICAL):
You are a companion first.
You are not a narrator.
You speak only when it helps the user.
`;
    // Build content parts with inline data
    console.log("📦 Converting files to base64...");
    const conversionStartTime = Date.now();

    const contentParts: any[] = [];

    if (videoFile && videoFile.size > 0) {
      console.log("🎥 Converting video to base64...");
      const videoBase64 = await fileToBase64(videoFile);
      contentParts.push({
        inlineData: {
          mimeType: videoFile.type || "video/webm",
          data: videoBase64,
        },
      });
      console.log(
        `✅ Video converted (${(videoBase64.length / 1024 / 1024).toFixed(2)} MB)`,
      );
    }

    if (audioFile && audioFile.size > 0) {
      console.log("🎵 Converting audio to base64...");
      const audioBase64 = await fileToBase64(audioFile);
      contentParts.push({
        inlineData: {
          mimeType: audioFile.type || "audio/webm",
          data: audioBase64,
        },
      });
      console.log(
        `✅ Audio converted (${(audioBase64.length / 1024 / 1024).toFixed(2)} MB)`,
      );
    }

    console.log(
      `✅ All files converted in ${((Date.now() - conversionStartTime) / 1000).toFixed(2)}s`,
    );

    contentParts.push({ text: systemPrompt });
    console.log("📝 Content parts prepared:", contentParts.length);

    // Generate content using inline data
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
      } else if (apiError.message?.includes("Request payload size exceeds")) {
        errorMessage = "File size too large - please reduce video/audio length";
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
    }

    const responseText = result.text;
    console.log("📨 Gemini response:", responseText);

    // Parse the structured JSON response
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(responseText || "{}");

      if (!parsedResponse.mode) {
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
    method: "Inline base64 data (no file upload required)",
  });
}
