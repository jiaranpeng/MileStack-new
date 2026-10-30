import React, { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X, ImagePlus, ClipboardPaste } from "lucide-react";
import { apiClient } from "../api/client";
import type { TaskImage } from "../types";

export function useTaskImages(onChange?: (images: TaskImage[]) => Promise<void>) {
  const [images, setImages] = useState<TaskImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(images); current.current = images;
  const pending = useRef(false);
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);
  const reset = (next: TaskImage[] = []) => { revision.current++; current.current = next; setImages(next); setError(null); };
  const commit = async (next: TaskImage[], token: number) => {
    if (token !== revision.current) return;
    await onChange?.(next);
    if (token === revision.current) { current.current = next; setImages(next); }
  };
  const add = async (files: File[]) => {
    if (!files.length) return;
    if (pending.current) { setError("图片正在保存，请稍候再粘贴。"); return; }
    if (current.current.length + files.length > 20) { setError("每个任务最多附加 20 张图片。"); return; }
    if (files.some((file) => file.size > 10 * 1024 * 1024)) { setError("每张图片最多 10 MB。"); return; }
    pending.current = true; setBusy(true); setError(null);
    const token = revision.current;
    try {
      const uploaded: TaskImage[] = [];
      for (const file of files) uploaded.push(await apiClient.uploadTaskImage(file));
      await commit([...current.current, ...uploaded], token);
    } catch (error) { if (token === revision.current) setError(error instanceof Error ? error.message : "图片上传失败。"); }
    finally { pending.current = false; setBusy(false); }
  };
  const remove = async (id: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    const token = revision.current;
    try { await commit(current.current.filter((image) => image.id !== id), token); }
    catch (error) { setError(error instanceof Error ? error.message : "移除图片失败。"); }
    finally { pending.current = false; setBusy(false); }
  };
  const onPaste = (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData.items).filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile()).filter((file): file is File => file !== null);
    if (files.length) { event.preventDefault(); event.stopPropagation(); void add(files); }
  };
  const paste = async () => {
    try {
      if (!navigator.clipboard?.read) throw new Error("请点击粘贴区域后按 Ctrl+V，或使用右键粘贴。");
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const type = item.types.find((type) => type.startsWith("image/"));
        if (type) files.push(new File([await item.getType(type)], "粘贴图片." + (type.split("/")[1] ?? "png"), { type }));
      }
      if (!files.length) throw new Error("剪贴板中没有图片，请先复制一张图片。");
      await add(files);
    } catch (error) { setError(error instanceof Error ? error.message : "读取剪贴板失败，请使用 Ctrl+V 或选择图片。"); }
  };
  return { images, busy, error, reset, add, remove, onPaste, paste };
}

export function TaskImageGallery({ images, onRemove, busy }: { images: TaskImage[]; onRemove?: (id: string) => void; busy?: boolean }) {
  const [preview, setPreview] = useState<TaskImage | null>(null);
  useEffect(() => {
    if (!preview) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPreview(null); } };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [preview]);
  return <>
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {images.map((image) => <div key={image.id} className="relative min-w-0 rounded border border-zinc-700 bg-zinc-900 overflow-hidden">
        <button type="button" aria-label={`预览图片：${image.name}`} onClick={() => setPreview(image)} className="block w-full text-left">
          <img src={`/api/images/${image.id}`} alt={image.name} loading="lazy" className="h-28 w-full object-contain bg-black/40" />
          <span className="block truncate px-2 py-1.5 text-[11px] text-zinc-300">{image.name}</span>
        </button>
        {onRemove && <button type="button" aria-label={`移除图片：${image.name}`} disabled={busy} onClick={() => onRemove(image.id)} className="absolute right-1 top-1 rounded bg-black/80 p-1 text-zinc-200 hover:text-rose-300"><X className="h-3 w-3" /></button>}
      </div>)}
    </div>
    {preview && <div role="dialog" aria-modal="true" aria-label="图片预览" className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-3 bg-black/90 p-6" onClick={() => setPreview(null)}>
      <div className="flex w-full max-w-5xl items-center justify-between gap-4 text-sm text-zinc-200" onClick={(event) => event.stopPropagation()}>
        <span className="truncate">{preview.name}</span>
        <div className="flex shrink-0 items-center gap-4"><a href={`/api/images/${preview.id}`} target="_blank" rel="noopener noreferrer" className="text-cyan-300">新窗口打开</a><button type="button" aria-label="关闭图片预览" onClick={() => setPreview(null)}><X className="h-5 w-5" /></button></div>
      </div>
      <img src={`/api/images/${preview.id}`} alt={preview.name} className="max-h-[80vh] max-w-[90vw] object-contain" onClick={(event) => event.stopPropagation()} />
    </div>}
  </>;
}

export function ImageAttachmentEditor({ editor }: { editor: ReturnType<typeof useTaskImages> }) {
  const input = useRef<HTMLInputElement>(null);
  return <section aria-label="任务图片" className="space-y-2">
    <h3 className="text-xs font-semibold text-zinc-300">图片附件</h3>
    <div role="textbox" aria-label="粘贴图片区域" contentEditable={!editor.busy} suppressContentEditableWarning tabIndex={0} onPaste={(event) => { editor.onPaste(event); event.preventDefault(); }}
      onInput={(event) => { event.currentTarget.textContent = ""; }} className="min-h-12 rounded border border-dashed border-zinc-600 bg-zinc-900/50 p-3 text-xs text-zinc-300 focus:border-cyan-500 focus:outline-none" />
    <p className="text-[11px] text-zinc-500">点击上方区域后按 Ctrl+V，或右键粘贴图片。支持 PNG、JPEG、GIF、WebP，单张最多 10 MB，最多 20 张。</p>
    <div className="flex gap-3 text-xs text-cyan-300">
      <button type="button" disabled={editor.busy} onClick={() => void editor.paste()} className="inline-flex items-center gap-1"><ClipboardPaste className="h-3.5 w-3.5" />粘贴图片</button>
      <button type="button" disabled={editor.busy} onClick={() => input.current?.click()} className="inline-flex items-center gap-1"><ImagePlus className="h-3.5 w-3.5" />选择图片</button>
      <input ref={input} type="file" aria-label="选择图片文件" accept="image/png,image/jpeg,image/gif,image/webp" multiple className="hidden"
        onChange={(event) => { void editor.add(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    </div>
    {editor.busy && <p role="status" className="text-xs text-cyan-300">正在保存图片…</p>}
    {editor.error && <p role="alert" className="text-xs text-rose-300">{editor.error}</p>}
    <TaskImageGallery images={editor.images} onRemove={(id) => void editor.remove(id)} busy={editor.busy} />
  </section>;
}

export function TaskDetailImages({ taskId, images }: { taskId: string; images: TaskImage[] }) {
  const queryClient = useQueryClient();
  const editor = useTaskImages(async (next) => {
    const details = await apiClient.setTaskImages(taskId, next.map((image) => image.id));
    queryClient.setQueryData(["taskDetails", taskId], details);
  });
  const imageKey = images.map((image) => image.id).join(",");
  useEffect(() => { editor.reset(images); }, [taskId, imageKey]);
  return <div onPaste={editor.onPaste}><ImageAttachmentEditor editor={editor} /></div>;
}
