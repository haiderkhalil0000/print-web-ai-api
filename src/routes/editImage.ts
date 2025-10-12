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

type MulterFile = Express.Multer.File;

type CustomizationDescriptor = {
  image?: MulterFile;
  metaData?: string;
};

type BundleDescriptor = {
  baseImage?: MulterFile;
  customizations: CustomizationDescriptor[];
};

function isMulterFile(value: unknown): value is MulterFile {
  return (
    !!value &&
    typeof value === "object" &&
    "fieldname" in value &&
    "path" in value
  );
}

function parseFieldPath(field: string): string[] {
  return field.replace(/\]/g, "").split(/\.|\[/).filter(Boolean);
}

function setNestedValue(
  target: Record<string, unknown>,
  path: string[],
  value: unknown
) {
  let current: Record<string, unknown> = target;
  for (let i = 0; i < path.length; i += 1) {
    const key = path[i];
    const isLast = i === path.length - 1;
    if (isLast) {
      const existing = current[key];
      if (existing === undefined) {
        current[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        current[key] = [existing, value];
      }
      continue;
    }

    const next = current[key];
    if (
      !next ||
      typeof next !== "object" ||
      Array.isArray(next) ||
      isMulterFile(next)
    ) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
}

function iterateIndexed(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (isMulterFile(value)) return [value];

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.every(([key]) => /^\d+$/.test(key))) {
      return entries
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([, v]) => v);
    }
  }

  return [value];
}

function toFileValue(value: unknown): MulterFile | undefined {
  for (const candidate of iterateIndexed(value)) {
    if (isMulterFile(candidate)) return candidate;
  }
  return undefined;
}

function toTextValue(value: unknown): string | undefined {
  for (const candidate of iterateIndexed(value)) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

const defaultPrompt = `Use the primary base character image as the canvas and blend in every customization bundle provided.
1. Study each bundle's base reference image to understand the target garment or feature before applying changes.
2. For every customization image, replace the matching region on the primary base so it perfectly matches the reference—color, texture, fit, and styling.
3. Never invent new elements; rely only on visible information in the provided images.
4. Keep the character's pose, anatomy, face, and skin tone identical to the primary base. The character must remain seated if the base image shows a seated pose.
5. Output a high-quality PNG with a fully transparent background (no shadows or gradients) and do not crop or zoom—preserve the full framing.
6. Blend all edits seamlessly so the result looks like a single cohesive photograph.
7. Make sure to check the in response image should have same amount of characters that we  have in baseimages`;

router.post("/edit-image", upload.any(), async (req, res) => {
  try {
    const filesArray = Array.isArray(req.files)
      ? (req.files as MulterFile[])
      : [];

    const structuredFields: Record<string, unknown> = {};

    for (const file of filesArray) {
      const parts = parseFieldPath(file.fieldname);
      if (!parts.length) continue;
      setNestedValue(structuredFields, parts, file);
    }

    for (const [field, value] of Object.entries(req.body)) {
      if (!field.includes("[") && !field.includes(".")) continue;
      const parts = parseFieldPath(field);
      if (!parts.length) continue;
      setNestedValue(structuredFields, parts, value);
    }

    const baseImage = toFileValue(structuredFields.baseImage);
    ensureAllowed(baseImage, "baseImage");

    const referenceImage =
      toFileValue(structuredFields.referenceImage) ??
      toFileValue(structuredFields.styleReference) ??
      toFileValue(structuredFields.styleImage) ??
      toFileValue(structuredFields.reference);

    if (referenceImage) {
      ensureAllowed(referenceImage, "referenceImage");
    }

    const maskFile = toFileValue(structuredFields.mask);
    if (maskFile) ensureAllowed(maskFile, "mask");

    const rawBundleSource =
      structuredFields["data"] ??
      structuredFields["bundles"] ??
      structuredFields["bundle"];

    const bundles: BundleDescriptor[] = rawBundleSource
      ? iterateIndexed(rawBundleSource).map((entry) => {
          if (!entry || typeof entry !== "object") {
            return { customizations: [] } satisfies BundleDescriptor;
          }
          const bundleObject = entry as Record<string, unknown>;
          const bundle: BundleDescriptor = {
            baseImage: toFileValue(bundleObject.baseImage),
            customizations: iterateIndexed(bundleObject.customizations).map(
              (customEntry) => {
                if (!customEntry || typeof customEntry !== "object") {
                  return {} as CustomizationDescriptor;
                }
                const customObject = customEntry as Record<string, unknown>;
                return {
                  image: toFileValue(customObject.image),
                  metaData: toTextValue(customObject.metaData),
                } satisfies CustomizationDescriptor;
              }
            ),
          };
          bundle.customizations = bundle.customizations.filter(
            (item) => item.image || item.metaData
          );
          return bundle;
        })
      : [];

    if (!bundles.length) {
      const looseCustomizations = iterateIndexed(
        structuredFields["customizations"]
      )
        .map((customEntry) => {
          if (!customEntry || typeof customEntry !== "object") {
            return {} as CustomizationDescriptor;
          }
          const customObject = customEntry as Record<string, unknown>;
          return {
            image: toFileValue(customObject.image),
            metaData: toTextValue(customObject.metaData),
          } satisfies CustomizationDescriptor;
        })
        .filter((item) => item.image || item.metaData);

      if (looseCustomizations.length) {
        bundles.push({
          baseImage: toFileValue(structuredFields.baseImage),
          customizations: looseCustomizations,
        });
      }
    }

    const sanitizedBundles = bundles.filter(
      (bundle) => bundle.baseImage || bundle.customizations.length > 0
    );

    const rawSize = String(
      req.body.size || process.env.IMAGE_SIZE || "1024x1536"
    );
    const sizeParam: ImageSize = (allowedSizes as readonly string[]).includes(
      rawSize
    )
      ? (rawSize as ImageSize)
      : "auto";

    const instructionBlocks: string[] = [];

    sanitizedBundles.forEach((bundle, bundleIndex) => {
      if (!bundle || (!bundle.baseImage && !bundle.customizations.length)) {
        return;
      }

      const lines: string[] = [];
      if (bundle.baseImage) {
        lines.push(
          "Use this bundle's base reference image to understand proportions and positioning before applying its customizations."
        );
      }

      bundle.customizations.forEach((customization, customizationIndex) => {
        const descriptor =
          customization.metaData &&
          customization.metaData.trim().replace(/\s+/g, " ");

        if (descriptor) {
          lines.push(descriptor);
        } else if (customization.image) {
          lines.push(
            `Apply customization image ${bundleIndex + 1}.${
              customizationIndex + 1
            } to replace its matching element on the primary base character.`
          );
        }
      });

      if (lines.length) {
        instructionBlocks.push(
          `Bundle ${bundleIndex + 1}:\n${lines
            .map((line) => `- ${line}`)
            .join("\n")}`
        );
      }
    });

    let prompt = String(req.body.prompt || "").trim();
    if (!prompt) {
      prompt = defaultPrompt;
    }

    if (instructionBlocks.length) {
      prompt += `\n\nDetailed customization instructions:\n${instructionBlocks.join(
        "\n"
      )}`;
    }

    if (referenceImage) {
      prompt +=
        "\n\nMatch the final render style, palette, and materials to the provided reference style image while preserving the primary base character's anatomy, seated pose, and lighting.";
    }

    const sizeOption = sizeParam === "auto" ? undefined : sizeParam;

    const orderedImageFiles: MulterFile[] = [];
    const seenPaths = new Set<string>();

    const addImage = (file: MulterFile | undefined, label: string) => {
      if (!file) return;
      ensureAllowed(file, label);
      if (seenPaths.has(file.path)) return;
      seenPaths.add(file.path);
      orderedImageFiles.push(file);
    };

    addImage(baseImage, "baseImage");

    sanitizedBundles.forEach((bundle, bundleIndex) => {
      if (bundle.baseImage) {
        addImage(bundle.baseImage, `data[${bundleIndex}].baseImage`);
      }
      bundle.customizations.forEach((customization, customizationIndex) => {
        if (customization.image) {
          addImage(
            customization.image,
            `data[${bundleIndex}].customizations[${customizationIndex}].image`
          );
        }
      });
    });

    addImage(referenceImage, "referenceImage");

    if (!orderedImageFiles.length) {
      throw Object.assign(
        new Error("No images were provided in the request."),
        { status: 400 }
      );
    }

    const resizedPaths = await Promise.all(
      orderedImageFiles.map((file) => resizeWithoutCrop(file.path))
    );

    const openAiImages = await Promise.all(
      orderedImageFiles.map((file, index) =>
        toFile(createReadStream(resizedPaths[index]), file.originalname, {
          type: "image/png",
        })
      )
    );

    const maskUpload = maskFile
      ? await toFile(createReadStream(maskFile.path), maskFile.originalname, {
          type: maskFile.mimetype,
        })
      : undefined;

    const result = await openai.images.edit({
      model: "gpt-image-1",
      prompt,
      image: openAiImages,
      ...(maskUpload ? { mask: maskUpload } : {}),
      ...(sizeOption ? { size: sizeOption } : {}),
      quality: "medium",
      background: "transparent",
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

    return res.status(502).json({ error: "Empty image response from OpenAI" });
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
});

export default router;
