import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, LoaderCircle, ExternalLink } from "lucide-react";
import { apiClient } from "../api/client";
import { projectStatusQueryKey } from "../pages/projectStatusQuery";
import type { TaskExecutionState } from "../types";

export function TaskExecutionPanel({ taskId, projectId }: { taskId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const storageKey = `milestack.codex-thread.${projectId}`;
  const [threadId, setThreadId] = useState(() => {
    try { return localStorage.getItem(storageKey) ?? ""; } catch { return ""; }
  });
  const threadsQuery = useQuery({ queryKey: ["codexThreads", projectId], queryFn: () => apiClient.getCodexThreads(), retry: false, refetchInterval: 15_000 });
  const stateQuery = useQuery({ queryKey: ["taskExecution", taskId], queryFn: () => apiClient.getTaskExecution(taskId), retry: false, refetchInterval: 3_000 });
  const state = stateQuery.data;
  const threads = threadsQuery.data?.threads ?? [];
  const selectedThread = threads.find((thread) => thread.id === threadId);
  const isIdle = selectedThread && ["idle", "notLoaded"].includes(selectedThread.status);

  useEffect(() => {
    if (threadsQuery.data && !threads.some((thread) => thread.id === threadId)) {
      setThreadId(threads.length === 1 ? threads[0]?.id ?? "" : "");
    }
  }, [threadsQuery.data, threadId]);
  useEffect(() => {
    if (state && state.taskStatus !== "ready") {
      void queryClient.invalidateQueries({ queryKey: ["taskDetails", taskId] });
      void queryClient.invalidateQueries({ queryKey: projectStatusQueryKey });
    }
  }, [state?.taskStatus, queryClient, taskId]);

  const execute = useMutation({
    mutationFn: () => apiClient.executeTask(taskId, threadId),
    onSuccess: (result) => {
      queryClient.setQueryData<TaskExecutionState>(["taskExecution", taskId], (previous) => ({
        taskStatus: previous?.taskStatus ?? "ready", reason: previous?.reason ?? null, canExecute: false, dispatch: result.dispatch,
      }));
      void queryClient.invalidateQueries({ queryKey: ["taskExecution", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["codexThreads", projectId] });
    },
    onError: () => { void queryClient.invalidateQueries({ queryKey: ["taskExecution", taskId] }); },
  });
  const dispatch = state?.dispatch;
  const error = execute.error ?? stateQuery.error ?? threadsQuery.error;

  return (
    <section aria-label="执行任务" className="rounded border border-emerald-900/60 bg-emerald-950/15 p-3.5 space-y-3">
      <div>
        <h3 className="text-xs font-semibold text-emerald-300">交给 Codex 执行</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">点击后向所选桌面聊天发送执行指令，由 Codex 领取本任务并开始实施。原有对话领取方式仍可使用。</p>
      </div>
      {!dispatch && (
        <div>
          <label htmlFor="execution-thread" className="block text-[11px] text-zinc-400 mb-1">当前项目的 Codex 桌面聊天</label>
          <select id="execution-thread" value={threadId} disabled={threadsQuery.isFetching || execute.isPending}
            onChange={(event) => {
              setThreadId(event.target.value);
              try { localStorage.setItem(storageKey, event.target.value); } catch { /* Selection still works without browser storage. */ }
            }} className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200">
            <option value="">{threadsQuery.isPending ? "正在连接桌面版…" : threads.length === 0 ? "该项目暂无可用的桌面聊天" : "请选择执行本任务的聊天"}</option>
            {threads.map((thread) => <option key={thread.id} value={thread.id} disabled={!["idle", "notLoaded"].includes(thread.status)}>{thread.title}{["idle", "notLoaded"].includes(thread.status) ? "" : "（正在工作）"}</option>)}
          </select>
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => execute.mutate()} disabled={!state?.canExecute || !isIdle || execute.isPending || !!dispatch}
          className="inline-flex shrink-0 items-center gap-1.5 rounded border border-emerald-700 bg-emerald-900/60 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-800/60 disabled:opacity-45 disabled:cursor-not-allowed">
          {execute.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {execute.isPending ? "正在发送…" : dispatch ? "执行指令已发送" : "执行任务"}
        </button>
        {dispatch && <a href={`codex://threads/${encodeURIComponent(dispatch.threadId)}`} className="inline-flex items-center gap-1 text-xs text-cyan-300 hover:underline">查看 Codex 聊天<ExternalLink className="h-3 w-3" /></a>}
      </div>
      {state?.reason && <p className="text-xs text-amber-300">{state.reason}</p>}
      {dispatch && <p role="status" className={`text-xs leading-relaxed ${dispatch.status === "unknown" ? "text-amber-300" : "text-emerald-300"}`}>
        {dispatch.status === "unknown" ? dispatch.message : `已发送至「${dispatch.threadTitle}」，等待 Codex 领取。领取成功后任务会自动进入“正在进行”。`}
      </p>}
      {error && <p role="alert" className="text-xs leading-relaxed text-rose-300">{error instanceof Error ? error.message : "发送失败，请检查桌面版连接。"}</p>}
      {threadsQuery.isError && <button type="button" onClick={() => void threadsQuery.refetch()} className="text-xs text-cyan-300 hover:underline">重新连接桌面版</button>}
    </section>
  );
}
