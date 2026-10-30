import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { imageReferencesSchema, importTaskImageSchema, MAX_IMAGE_BYTES, MAX_TASK_IMAGES, taskImageSchema, type TaskImage } from "../core/task-images.js";

const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as const;
export class TaskImageInputError extends Error {}
function imageMime(bytes: Buffer): TaskImage["mimeType"] {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("请选择 PNG、JPEG、GIF 或 WebP 图片。");
}
function imageRoot(projectRoot: string) { return path.join(projectRoot, ".milestack", "images"); }
function checkedFile(root: string, filename: string): string {
  const fullPath = path.join(root, filename);
  const realRoot = realpathSync(root);
  const realFile = realpathSync(fullPath);
  if (path.dirname(realFile) !== realRoot) throw new Error("图片文件不属于当前项目。");
  return realFile;
}
export function readTaskImage(projectRoot: string, id: string): { image: TaskImage; bytes: Buffer; localPath: string } {
  z.string().uuid().parse(id);
  const root = imageRoot(projectRoot);
  const image = taskImageSchema.parse(JSON.parse(readFileSync(checkedFile(root, `${id}.json`), "utf8")));
  if (image.id !== id) throw new Error("图片元数据不匹配。");
  const localPath = checkedFile(root, `${id}.${extensions[image.mimeType]}`);
  if (statSync(localPath).size > MAX_IMAGE_BYTES) throw new Error("图片超过 10 MB。");
  const bytes = readFileSync(localPath);
  if (bytes.length !== image.size || imageMime(bytes) !== image.mimeType) throw new Error("图片文件已损坏或类型不匹配。");
  return { image, bytes, localPath };
}
export function importTaskImage(projectRoot: string, input: z.input<typeof importTaskImageSchema>): TaskImage {
  const parsed = importTaskImageSchema.parse(input);
  if (Number(!!parsed.localPath) + Number(!!parsed.dataBase64) !== 1) throw new Error("请提供一个本地图片路径或图片 Base64 内容。");
  let bytes: Buffer;
  if (parsed.localPath) {
    if (!path.isAbsolute(parsed.localPath)) throw new Error("图片路径须为本机绝对路径。");
    const stat = statSync(parsed.localPath);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error("图片须为文件且不超过 10 MB。");
    bytes = readFileSync(parsed.localPath);
  } else {
    const base64 = parsed.dataBase64 ?? "";
    if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("图片 Base64 内容无效。");
    bytes = Buffer.from(base64, "base64");
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("每张图片须不超过 10 MB。");
  const mimeType = imageMime(bytes);
  const rawName = parsed.name ?? (parsed.localPath ? path.basename(parsed.localPath) : `图片.${extensions[mimeType]}`);
  const image = taskImageSchema.parse({ id: randomUUID(), name: path.basename(rawName).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200) || `图片.${extensions[mimeType]}`, mimeType, size: bytes.length });
  const root = imageRoot(projectRoot);
  mkdirSync(root, { recursive: true });
  const filename = path.join(root, `${image.id}.${extensions[mimeType]}`);
  writeFileSync(filename, bytes, { flag: "wx" });
  try { writeFileSync(path.join(root, `${image.id}.json`), JSON.stringify(image), { flag: "wx" }); }
  catch (error) { unlinkSync(filename); throw error; }
  return image;
}
export function resolveTaskImageInput(projectRoot: string, input: z.input<typeof imageReferencesSchema>): TaskImage[] {
  try {
  const parsed = imageReferencesSchema.parse(input);
  if ((parsed.imageIds?.length ?? 0) + (parsed.imagePaths?.length ?? 0) > MAX_TASK_IMAGES) throw new Error("每个任务最多附加 20 张图片。");
  const existing = (parsed.imageIds ?? []).map((id) => readTaskImage(projectRoot, id).image);
  const imported = (parsed.imagePaths ?? []).map((localPath) => importTaskImage(projectRoot, { localPath }));
  return [...new Map([...existing, ...imported].map((image) => [image.id, image])).values()];
  } catch (error) { throw new TaskImageInputError(error instanceof Error ? error.message : "图片引用无效。"); }
}
