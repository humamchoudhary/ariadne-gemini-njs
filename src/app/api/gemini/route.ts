import { NextRequest, NextResponse } from "next/server";
// import { GoogleGenerativeAI } from "@google/generative-ai";
//
import { GoogleGenAI, MediaResolution, ThinkingLevel } from "@google/genai";
// Initialize Gemini AI
const genAI = new GoogleGenAI({});

// Define the structured output schema for Gemini responses
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
      description:
        "Whether this response should be spoken to the user via TTS. Set to false if the scene hasn't changed significantly or if there's nothing important to report.",
    },
    transcription: {
      type: "string",
      description: "Audio transcription of what the user said",
    },
  },
  required: ["analysis", "mode", "shouldRespond", "transcription"],
};

export async function POST(request: NextRequest) {
  console.log(process.env.GEMINI_API_KEY);
  try {
    const formData = await request.formData();
    const videoFile = formData.get("video") as File | null;
    const audioFile = formData.get("audio") as File | null;
    const userIntent = formData.get("intent") as string | null;
    const currentMode = formData.get("currentMode") as string | null;

    // Convert files to base64 if they exist
    let videoBase64: string | null = null;
    let audioBase64: string | null = null;

    if (videoFile && videoFile.size > 0) {
      const videoBuffer = await videoFile.arrayBuffer();
      videoBase64 = Buffer.from(videoBuffer).toString("base64");
    }

    if (audioFile && audioFile.size > 0) {
      const audioBuffer = await audioFile.arrayBuffer();
      audioBase64 = Buffer.from(audioBuffer).toString("base64");
    }

    // Build the prompt based on user intent and current mode
    let systemPrompt = `You are an AI assistant for visually impaired users. Analyze the provided video and audio content. however not everytime you have to give the description of scene only when the user asks,

            also you will be answering any question user asks.
    
Current mode: ${currentMode || "idle"}
User intent: ${userIntent || "general awareness"}

CRITICAL: Respond with a JSON object matching this schema:
{
  "analysis": "Your analysis here - be concise and actionable",
  "mode": "idle|continuous|single", 
  "reason": "Brief explanation of mode choice",
  "shouldRespond": true|false,
  "transcription":"Audio transcription of what user said"
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
  * If there is noise or no question asked
  * Scene hasn't changed significantly from last analysis
  * Nothing important to report
  * User is in idle mode and no questions were asked
  * Repetitive information that was already mentioned

RESPONSE RULES:
1. Prioritize safety - identify obstacles, moving objects, stairs
2. Give clear directional guidance: left, right, forward, stop
3. Be extremely concise - maximum 2 short sentences
4. Never explain your reasoning in the analysis`;

    const parts: any[] = [{ text: systemPrompt }];

    if (videoBase64) {
      parts.push({
        inlineData: {
          mimeType: "video/webm",
          data: videoBase64,
        },
      });
    }

    if (audioBase64) {
      parts.push({
        inlineData: {
          mimeType: "audio/mp3",
          data: audioBase64,
        },
      });
    }

    // console.log(parts);
    console.log(videoFile?.size);
    console.log(audioFile?.size);

    // const model = genAI.getGenerativeModel({
    //   model: "gemini-3-flash-preview",
    //   generationConfig: {
    //     responseMimeType: "application/json",
    //     responseSchema: responseSchema,
    //   },
    // });

    const result = await genAI.models.generateContent({
      contents: [{ parts }],
      model: "gemini-3-flash-preview",
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.LOW,
        },
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
      },
    });

    const responseText = result.text;
    console.log(responseText);

    // Parse the structured JSON response
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(responseText || "");
      console.log(parsedResponse);
    } catch (e) {
      console.error("Failed to parse structured response:", responseText);
      // Fallback to manual parsing if structured output fails
      parsedResponse = {
        analysis: responseText.replace(/["{}]/g, "").substring(0, 200),
        mode: "single",
        reason: "Fallback due to parse error",
        shouldRespond: true, // Default to responding on error
      };
    }

    return NextResponse.json({
      success: true,
      data: parsedResponse,
    });
  } catch (error) {
    console.error("Gemini API error:", error);
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

// Handle health check
export async function GET() {
  return NextResponse.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
}
