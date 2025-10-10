// src/routes/editImage.ts
import { Router } from "express";
import multer from "multer";
import { tmpdir } from "os";
import { openai } from "../lib/openai";
import { toFile } from "openai/uploads";
import { createReadStream } from "fs";
import sharp from "sharp";

const upload = multer({
  dest: tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

async function resizeWithoutCrop(
  filePath: string,
  maxWidth = 1024,
  maxHeight = 1024
) {
  const img = sharp(filePath);
  const metadata = await img.metadata();

  if (!metadata.width || !metadata.height) return filePath;

  const ratio = Math.min(
    maxWidth / metadata.width,
    maxHeight / metadata.height,
    1
  );
  const width = Math.round(metadata.width * ratio);
  const height = Math.round(metadata.height * ratio);

  const outputPath = filePath + "_resized.png";

  await img
    .resize(width, height, {
      fit: "contain", // ensures no cropping
      background: { r: 0, g: 0, b: 0, alpha: 0 }, // transparent padding
    })
    .png()
    .toFile(outputPath);

  return outputPath;
}

const router = Router();

const allowedSizes = [
  "256x256",
  "512x512",
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "auto",
] as const;
type ImageSize = (typeof allowedSizes)[number];

const allowedMime = new Set(["image/jpeg", "image/png", "image/webp"]);

function ensureAllowed(
  file?: Express.Multer.File,
  name = "image"
): asserts file is Express.Multer.File {
  if (!file)
    throw Object.assign(new Error(`${name} is required`), { status: 400 });
  if (!allowedMime.has(file.mimetype)) {
    const msg = `Invalid file '${name}': unsupported mimetype ('${file.mimetype}'). Supported: image/jpeg, image/png, image/webp.`;
    throw Object.assign(new Error(msg), {
      status: 400,
      code: "unsupported_file_mimetype",
      param: name,
    });
  }
}

router.post(
  "/edit-image",
  upload.fields([
    { name: "image1" },
    { name: "image2" },
    { name: "image3" },
    { name: "image4" },
    { name: "mask" },
  ]),
  async (req, res) => {
    try {
      const prompt = String(
        req.body.prompt ||
          `
Look carefully at image1 — this is the BASE CHARACTER.  
Look at image2, image3, image4, and any other reference images provided — these represent CUSTOMIZATION ELEMENTS.

Your task:
1. Identify each customization element in the reference images — such as hairstyle, clothing (shirt, pants, jacket, shoes, etc.), or accessories.  
2. Completely replace the corresponding parts of the base character (image1) with those elements.  
   - The replacement must exactly match the design, color, texture, and style shown in the reference images.  
   - For hair, ensure it exactly matches the provided reference — style, length, direction, and color — and completely replace the original hair in image1.  
3. Do not invent or add anything that is not visible in the provided images.  
   - Strictly use only the given reference images.  
   - No extra items, backgrounds, effects, or AI-created details.  
4. Keep all unchanged features from image1 identical — including body shape, pose, facial features, skin tone, and proportions.  
5. Output the final image as a high-quality PNG file with a fully transparent background (no background color, shadows, or gradients).  
6. Blend all replaced elements seamlessly and realistically so that the final character looks natural.  
7. Do NOT crop or zoom; preserve the full visible area of the base character.
`
      );

      const rawSize = String(
        req.body.size || process.env.IMAGE_SIZE || "1024x1024"
      );
      const sizeParam: ImageSize = (allowedSizes as readonly string[]).includes(
        rawSize
      )
        ? (rawSize as ImageSize)
        : "auto"; // ✅ use "auto" to avoid forced cropping

      const files = req.files as Record<string, Express.Multer.File[]>;
      const img1 = files?.image1?.[0];
      const img2 = files?.image2?.[0];
      const img3 = files?.image3?.[0];
      const img4 = files?.image4?.[0];
      const mask = files?.mask?.[0];

      ensureAllowed(img1, "image[0]");
      ensureAllowed(img2, "image[1]");
      ensureAllowed(img3, "image[2]");
      ensureAllowed(img4, "image[3]");
      if (mask) ensureAllowed(mask, "mask");

      // ✅ Resize images without cropping
      const img1Path = await resizeWithoutCrop(img1.path);
      const img2Path = await resizeWithoutCrop(img2.path);
      const img3Path = await resizeWithoutCrop(img3.path);
      const img4Path = await resizeWithoutCrop(img4.path);

      // ✅ Convert resized images to OpenAI-compatible files
      const imgFile1 = await toFile(
        createReadStream(img1Path),
        img1.originalname,
        { type: "image/png" }
      );
      const imgFile2 = await toFile(
        createReadStream(img2Path),
        img2.originalname,
        { type: "image/png" }
      );
      const imgFile3 = await toFile(
        createReadStream(img3Path),
        img3.originalname,
        { type: "image/png" }
      );
      const imgFile4 = await toFile(
        createReadStream(img4Path),
        img4.originalname,
        { type: "image/png" }
      );

      const maskFile = mask
        ? await toFile(createReadStream(mask.path), mask.originalname, {
            type: mask.mimetype,
          })
        : undefined;

      // ✅ Call OpenAI image edit API
      const result = await openai.images.edit({
        model: "gpt-image-1",
        prompt,
        image: [imgFile1, imgFile2, imgFile3, imgFile4],
        ...(maskFile ? { mask: maskFile } : {}),
        size: sizeParam,
        n: 1,
      });

      const data = result.data?.[0];
      const b64 = (data as any)?.b64_json as string | undefined;
      const url = (data as any)?.url as string | undefined;

      if (b64) {
        const buffer = Buffer.from(b64, "base64");
        res.setHeader("Content-Type", "image/png");
        return res.send(buffer);
      }

      if (url) {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Failed to fetch image URL: ${r.status}`);
        const ab = await r.arrayBuffer();
        res.setHeader(
          "Content-Type",
          r.headers.get("content-type") || "image/png"
        );
        return res.send(Buffer.from(ab));
      }

      return res
        .status(502)
        .json({ error: "Empty image response from OpenAI" });
    } catch (e: any) {
      console.error(e);
      const status =
        e?.status && e.status >= 400 && e.status < 600 ? e.status : 500;
      return res.status(status).json({
        error: e?.message || "Image edit failed",
        code: e?.code,
        param: e?.param,
        request_id: e?.request_id,
      });
    }
  }
);

export default router;
