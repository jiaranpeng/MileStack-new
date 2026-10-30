import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { imageReferencesSchema, MAX_IMAGE_BYTES } from "../core/task-images.js";
import { importTaskImage, readTaskImage, resolveTaskImageInput } from "../images/image-store.js";
import type { ProjectContext } from "../project/project-context.js";
import { guardLocalRequest } from "./desktop-execution.js";

// Explicit exports used by the compatibility build for the installed baseline.
export { taskImagesSchema, setTaskImagesInputSchema, imageReferencesSchema, importTaskImageSchema, getTaskImageInputSchema } from "../core/task-images.js";
export { importTaskImage, readTaskImage, resolveTaskImageInput, TaskImageInputError } from "../images/image-store.js";

export function registerTaskImageRoutes(app: FastifyInstance, context: ProjectContext): void {
  app.post("/api/images", { bodyLimit: Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4096 }, async (request, reply) => {
    try {
      guardLocalRequest(request, "图片操作");
      const input = z.object({ name: z.string().max(200).optional(), dataBase64: z.string() }).strict().parse(request.body);
      return reply.code(201).send({ image: importTaskImage(context.projectRoot, input) });
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 400;
      return reply.code(status).send({ error: error instanceof Error ? error.message : "图片上传失败。" });
    }
  });
  app.get("/api/images/:id", async (request, reply) => {
    try {
      guardLocalRequest(request, "图片操作");
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { image, bytes } = readTaskImage(context.projectRoot, id);
      return reply.header("Content-Type", image.mimeType).header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, max-age=3600").send(bytes);
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 404;
      return reply.code(status).send({ error: "图片不存在、已损坏或不属于本项目。" });
    }
  });
  app.put("/api/tasks/:id/images", async (request, reply) => {
    try {
      guardLocalRequest(request, "图片操作");
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const { imageIds } = imageReferencesSchema.pick({ imageIds: true }).required().strict().parse(request.body);
      return context.service.setTaskImages({ projectId: context.project.id, taskId: id,
        images: resolveTaskImageInput(context.projectRoot, { imageIds }) });
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) :
        error && typeof error === "object" && "code" in error && error.code === "TASK_NOT_FOUND" ? 404 : 400;
      return reply.code(status).send({ error: error instanceof Error ? error.message : "保存任务图片失败。" });
    }
  });
}
