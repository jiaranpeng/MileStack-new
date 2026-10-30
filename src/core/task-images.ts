import { z } from "zod";

export const MAX_TASK_IMAGES = 20;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const taskImageSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(200),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  size: z.number().int().positive().max(MAX_IMAGE_BYTES),
}).strict();
export type TaskImage = z.infer<typeof taskImageSchema>;
export const taskImagesSchema = z.array(taskImageSchema).max(MAX_TASK_IMAGES).refine(
  (images) => new Set(images.map((image) => image.id)).size === images.length,
  "图片不可重复。",
);
export const imageReferencesSchema = z.object({
  imageIds: z.array(z.string().uuid()).max(MAX_TASK_IMAGES).optional().describe("IDs returned by import_task_image or the image upload API."),
  imagePaths: z.array(z.string().min(1)).max(MAX_TASK_IMAGES).optional().describe("Absolute local paths of images included in the plan. They are copied into this project's image store; include every plan image here or via imageIds."),
});
export const importTaskImageSchema = z.object({
  localPath: z.string().min(1).optional(),
  dataBase64: z.string().max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4).optional(),
  name: z.string().max(200).optional(),
}).strict();
export const getTaskImageInputSchema = z.object({ taskId: z.string().min(1), imageId: z.string().uuid() }).strict();
export const setTaskImagesInputSchema = z.object({ projectId: z.string().min(1), taskId: z.string().min(1), images: taskImagesSchema }).strict();
