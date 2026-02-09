import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

const genAI = new GoogleGenAI({});

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const imageFiles = formData.getAll("images") as File[];
    const descriptions = formData.getAll("descriptions") as string[];

    if (!imageFiles || imageFiles.length === 0) {
      return NextResponse.json(
        { success: false, error: "No images provided" },
        { status: 400 },
      );
    }

    console.log(`📤 Received ${imageFiles.length} images for upload to Gemini`);

    const uploadedFiles = [];

    for (let i = 0; i < imageFiles.length; i++) {
      const imageFile = imageFiles[i];
      const description =
        descriptions[i] || imageFile.name.replace(/\.[^/.]+$/, "");

      // Validate it's an image
      if (!imageFile.type.startsWith("image/")) {
        console.log(`⚠️ Skipping non-image file: ${imageFile.name}`);
        continue;
      }

      try {
        console.log(`📤 Uploading ${imageFile.name} to Gemini File API...`);

        // Convert File to buffer for upload
        const buffer = Buffer.from(await imageFile.arrayBuffer());

        // Create a temporary file path (Gemini API needs a file path)
        const temp = require("fs").promises;
        const path = require("path");
        const tempDir = path.join(process.cwd(), "temp");
        await temp.mkdir(tempDir, { recursive: true });

        const tempPath = path.join(
          tempDir,
          `upload_${Date.now()}_${imageFile.name}`,
        );
        await temp.writeFile(tempPath, buffer);

        // Upload to Gemini File API with displayName
        const uploadedFile = await genAI.files.upload({
          file: tempPath,
          config: {
            mimeType: imageFile.type,
            displayName: description, // Use the description as display name
          },
        });

        // Clean up temp file
        await temp.unlink(tempPath).catch(() => {});

        uploadedFiles.push({
          name: imageFile.name,
          displayName: description,
          uri: uploadedFile.uri,
          mimeType: uploadedFile.mimeType,
          size: imageFile.size,
        });

        console.log(
          `✅ ${imageFile.name} uploaded to Gemini as "${description}"`,
        );
        console.log(`   URI: ${uploadedFile.uri}`);
      } catch (uploadError) {
        console.error(`❌ Failed to upload ${imageFile.name}:`, uploadError);
      }
    }

    // Get total count of files in Gemini
    const listResponse = await genAI.files.list({ config: { pageSize: 100 } });
    let totalFiles = 0;
    for await (const file of listResponse) {
      totalFiles++;
    }

    return NextResponse.json({
      success: true,
      message: `Successfully uploaded ${uploadedFiles.length} images to Gemini`,
      uploaded: uploadedFiles,
      totalBookmarks: totalFiles,
    });
  } catch (error) {
    console.error("❌ Upload error:", error);
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

export async function GET(request: NextRequest) {
  try {
    console.log("📋 Listing files from Gemini File API...");

    const files = [];
    const listResponse = await genAI.files.list({ config: { pageSize: 100 } });

    for await (const file of listResponse) {
      files.push({
        name: file.name,
        displayName: file.displayName,
        uri: file.uri,
        mimeType: file.mimeType,
        size: file.sizeBytes,
        createdAt: file.createTime,
      });
    }

    return NextResponse.json({
      success: true,
      count: files.length,
      files: files,
    });
  } catch (error) {
    console.error("❌ Error listing files:", error);
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

// export async function DELETE(request: NextRequest) {
//   try {
//     const { searchParams } = new URL(request.url);
//     const fileUri = searchParams.get("uri");
//
//     if (!fileUri) {
//       return NextResponse.json(
//         { success: false, error: "No file URI provided" },
//         { status: 400 },
//       );
//     }
//
//     console.log(`🗑️ Deleting file from Gemini: ${fileUri}`);
//
//     try {
//       await genAI.files.delete({ fileUri });
//
//       return NextResponse.json({
//         success: true,
//         message: `File deleted successfully`,
//       });
//     } catch (error: any) {
//       if (error.message?.includes("NOT_FOUND")) {
//         return NextResponse.json(
//           { success: false, error: "File not found in Gemini" },
//           { status: 404 },
//         );
//       }
//       throw error;
//     }
//   } catch (error) {
//     console.error("❌ Error deleting file:", error);
//     return NextResponse.json(
//       {
//         success: false,
//         error:
//           error instanceof Error ? error.message : "Unknown error occurred",
//       },
//       { status: 500 },
//     );
//   }
// }
