import { list, put } from "@vercel/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function safePart(value: unknown, fallback: string) {
  const text = String(value ?? fallback).trim();
  return (text || fallback).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const image = form.get("image");
    if (!(image instanceof File)) {
      return Response.json({ error: "Missing frame image." }, { status: 400 });
    }

    const matchId = safePart(form.get("match_id"), "unknown");
    const sampleId = safePart(form.get("sample_id"), String(Date.now()));
    const timestampSeconds = Number(form.get("timestamp_seconds") || 0);
    const videoUrl = String(form.get("video_url") || "");
    const filename = String(form.get("filename") || "");
    const x = Number(form.get("x"));
    const y = Number(form.get("y"));
    const width = Number(form.get("width"));
    const height = Number(form.get("height"));
    const frameWidth = Number(form.get("frame_width"));
    const frameHeight = Number(form.get("frame_height"));

    const values = [x, y, width, height];
    if (values.some((value) => !Number.isFinite(value)) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.0001 || y + height > 1.0001) {
      return Response.json({ error: "Ball box must be normalized inside the frame." }, { status: 400 });
    }

    const cx = x + width / 2;
    const cy = y + height / 2;
    const yoloLabel = `0 ${cx.toFixed(8)} ${cy.toFixed(8)} ${width.toFixed(8)} ${height.toFixed(8)}\n`;
    const base = `ball-training/${matchId}/${sampleId}`;

    const [imageBlob, labelBlob] = await Promise.all([
      put(`${base}.jpg`, image, {
        access: "public",
        contentType: image.type || "image/jpeg",
        addRandomSuffix: false,
      }),
      put(`${base}.txt`, yoloLabel, {
        access: "public",
        contentType: "text/plain",
        addRandomSuffix: false,
      }),
    ]);

    const metadata = {
      schema_version: 1,
      class_id: 0,
      class_name: "volleyball",
      created_at: new Date().toISOString(),
      match_id: matchId,
      sample_id: sampleId,
      timestamp_seconds: timestampSeconds,
      source_video_url: videoUrl,
      source_filename: filename,
      frame_width: frameWidth,
      frame_height: frameHeight,
      box_normalized: { x, y, width, height, cx, cy },
      image_url: imageBlob.url,
      label_url: labelBlob.url,
      image_pathname: imageBlob.pathname,
      label_pathname: labelBlob.pathname,
    };

    const metadataBlob = await put(`${base}.json`, JSON.stringify(metadata, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return Response.json({ ok: true, ...metadata, metadata_url: metadataBlob.url });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not save ball training sample." },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<Response> {
  try {
    const result = await list({ prefix: "ball-training/", limit: 1000 });
    const metadataBlobs = result.blobs.filter((blob) => blob.pathname.endsWith(".json"));
    return Response.json({
      ok: true,
      count: metadataBlobs.length,
      samples: metadataBlobs.map((blob) => ({
        metadata_url: blob.url,
        pathname: blob.pathname,
        size: blob.size,
        uploadedAt: blob.uploadedAt,
      })),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not list ball training samples." },
      { status: 500 },
    );
  }
}
