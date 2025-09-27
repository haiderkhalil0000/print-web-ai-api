// src/routes/editImage.ts
import { Router } from "express";
import multer from "multer";
import { tmpdir } from "os";
import { openai } from "../lib/openai";
import { toFile } from "openai/uploads";
import { createReadStream } from "fs";

const upload = multer({
  dest: tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

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
  if (!file) throw Object.assign(new Error(`${name} is required`), { status: 400 });
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
  upload.fields([{ name: "image1" }, { name: "image2" }, { name: "mask" }]),
  async (req, res) => {
    try {
      const prompt = String(req.body.prompt || "Look at image1 (the base character).Look at image2 (the reference item).Automatically identify whether image2 contains a hairstyle, clothing item (shirt, shorts, jacket, etc.), or accessory.Apply the design, color, and style from image2 onto the corresponding part of the character in image1.Keep all other features of image1 unchanged — body, skin tone, pose, background, and unrelated clothing must remain exactly the same.Blend the new element naturally so it looks seamless and realistic on the character.Do not generate anything extra beyond applying the item from image2.");
      if (!prompt) return res.status(400).json({ error: "prompt is required" });

      const rawSize = String(req.body.size || "1024x1024");
      const sizeParam: ImageSize = (allowedSizes as readonly string[]).includes(rawSize)
        ? (rawSize as ImageSize)
        : "1024x1024";

      const files = req.files as Record<string, Express.Multer.File[]>;
      const img1 = files?.image1?.[0];
      const img2 = files?.image2?.[0];
      const mask = files?.mask?.[0];

      ensureAllowed(img1, "image[0]");
      ensureAllowed(img2, "image[1]");
      if (mask) ensureAllowed(mask, "mask");

      // ✅ Wrap temp paths in ReadStreams so toFile() receives a valid input
      const imgFile1 = await toFile(createReadStream(img1.path), img1.originalname, { type: img1.mimetype });
      const imgFile2 = await toFile(createReadStream(img2.path), img2.originalname, { type: img2.mimetype });
      const maskFile = mask
        ? await toFile(createReadStream(mask.path), mask.originalname, { type: mask.mimetype })
        : undefined;

      const result = await openai.images.edit({
        model: "gpt-image-1",
        prompt,
        image: [imgFile1, imgFile2],
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
        res.setHeader("Content-Type", r.headers.get("content-type") || "image/png");
        return res.send(Buffer.from(ab));
      }

      return res.status(502).json({ error: "Empty image response from OpenAI" });
    } catch (e: any) {
      console.error(e);
      const status = e?.status && e.status >= 400 && e.status < 600 ? e.status : 500;
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
