import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { GoogleApiError, type TasksClient } from "../google/client.js";
import type { TaskInput } from "../google/types.js";
import { fromApiDate, toApiDate } from "../utils/dates.js";
import { describeError, jsonResult, runTool } from "../utils/result.js";
import {
  dateSchema,
  listRefSchema,
  notesSchema,
  titleSchema,
  toView,
  type TaskView,
} from "./shared.js";

/** Parallel inserts per batch. Google publishes no per-user QPS for Tasks. */
const CONCURRENCY = 4;
/** One retry on 429/5xx with jitter. */
const RETRY_BASE_MS = 750;

const taskItemSchema = z.object({
  title: titleSchema,
  notes: notesSchema.optional(),
  due: dateSchema.optional(),
  parentTaskId: z.string().optional().describe("Make this a subtask of an existing task"),
});

interface ItemResult {
  index: number;
  title: string;
  due?: string;
  ok: boolean;
  skipped?: true;
  task?: TaskView;
  error?: string;
}

export function registerBulkTools(server: McpServer, client: TasksClient): void {
  server.registerTool(
    "create_tasks",
    {
      title: "Create many tasks",
      description:
        "Create up to 100 tasks in one call (e.g. every reading from a syllabus). Each item takes title, optional notes, optional due (YYYY-MM-DD, all-day). With skipIfExists=true (default) an item whose title AND due exactly match an existing open task in the list is skipped, so retrying is safe. Returns a per-item report — check it for partial failures.",
      inputSchema: z.object({
        list: listRefSchema,
        tasks: z.array(taskItemSchema).min(1).max(100),
        skipIfExists: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ list, tasks, skipIfExists }) =>
      runTool(async () => {
        const { id, title: listTitle } = await client.resolveList(list);

        // Validate every date up front so a typo in item 17 fails the whole
        // call before anything is written, not after 16 inserts.
        const prepared = tasks.map((t, index) => {
          const body: TaskInput = { title: t.title };
          if (t.notes) body.notes = t.notes;
          if (t.due) body.due = toApiDate(t.due, `tasks[${index}].due`);
          return { index, item: t, body };
        });

        const existing = new Set<string>();
        if (skipIfExists) {
          const { tasks: open } = await client.listAllTasks(id, {
            showCompleted: false,
            showHidden: false,
          });
          for (const t of open) existing.add(fingerprint(t.title, fromApiDate(t.due)));
        }

        const results: ItemResult[] = new Array(prepared.length);
        let cursor = 0;
        const worker = async (): Promise<void> => {
          while (cursor < prepared.length) {
            const job = prepared[cursor++]!;
            const base: ItemResult = { index: job.index, title: job.item.title, ok: false };
            if (job.item.due) base.due = job.item.due;
            const fp = fingerprint(job.item.title, job.item.due);
            if (skipIfExists && existing.has(fp)) {
              results[job.index] = { ...base, ok: true, skipped: true };
              continue;
            }
            try {
              const created = await withRetry(() =>
                client.insertTask(id, job.body, { parent: job.item.parentTaskId }),
              );
              existing.add(fp);
              results[job.index] = { ...base, ok: true, task: toView(created) };
            } catch (err) {
              results[job.index] = { ...base, ok: false, error: describeError(err) };
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, prepared.length) }, worker));

        const created = results.filter((r) => r.ok && !r.skipped).length;
        const skipped = results.filter((r) => r.skipped).length;
        const failed = results.filter((r) => !r.ok).length;
        return jsonResult({
          list: { id, title: listTitle },
          summary: { requested: results.length, created, skipped, failed },
          results,
        });
      }),
  );
}

function fingerprint(title: string, due: string | undefined): string {
  return `${title.trim().toLowerCase()}|${due ?? ""}`;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const retryable =
      err instanceof GoogleApiError && (err.status === 429 || err.status >= 500);
    if (!retryable) throw err;
    await new Promise((r) => setTimeout(r, RETRY_BASE_MS + Math.random() * RETRY_BASE_MS));
    return fn();
  }
}
