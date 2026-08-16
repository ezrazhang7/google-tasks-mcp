import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { TasksClient } from "../google/client.js";
import type { ListTasksParams, Task, TaskInput } from "../google/types.js";
import { toApiDate, toApiDateExclusiveEnd } from "../utils/dates.js";
import { jsonResult, runTool, textResult } from "../utils/result.js";
import {
  dateSchema,
  listRefSchema,
  notesSchema,
  taskIdSchema,
  titleSchema,
  toView,
} from "./shared.js";

export function registerTaskTools(server: McpServer, client: TasksClient): void {
  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List tasks in a task list, optionally filtered by status and due-date window. Defaults to open (not completed) tasks in the default list. Dates are YYYY-MM-DD.",
      inputSchema: z.object({
        list: listRefSchema,
        status: z
          .enum(["open", "completed", "all"])
          .default("open")
          .describe("open = needsAction only; completed = completed only (includes hidden ones); all = both"),
        dueAfter: dateSchema.optional().describe("Only tasks due on or after this date (YYYY-MM-DD)"),
        dueBefore: dateSchema.optional().describe("Only tasks due on or before this date (YYYY-MM-DD, inclusive)"),
        updatedAfter: z
          .string()
          .optional()
          .describe("Only tasks modified after this RFC 3339 timestamp"),
        includeDeleted: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ list, status, dueAfter, dueBefore, updatedAfter, includeDeleted, limit }) =>
      runTool(async () => {
        const { id, title } = await client.resolveList(list);
        const params: ListTasksParams = {
          showCompleted: status !== "open",
          // Tasks completed in Google's own UI are usually `hidden`; without
          // this flag "completed" would return nothing.
          showHidden: status !== "open",
          showDeleted: includeDeleted,
          showAssigned: true,
        };
        if (dueAfter) params.dueMin = toApiDate(dueAfter, "dueAfter");
        if (dueBefore) params.dueMax = toApiDateExclusiveEnd(dueBefore, "dueBefore");
        if (updatedAfter) params.updatedMin = updatedAfter;
        const { tasks, truncated } = await client.listAllTasks(id, params, limit);
        const filtered =
          status === "completed"
            ? tasks.filter((t) => t.status === "completed")
            : tasks;
        return jsonResult({
          list: { id, title },
          count: filtered.length,
          truncated,
          tasks: filtered.map(toView),
        });
      }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description: "Fetch a single task by id.",
      inputSchema: z.object({ list: listRefSchema, taskId: taskIdSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ list, taskId }) =>
      runTool(async () => {
        const { id } = await client.resolveList(list);
        return jsonResult(toView(await client.getTask(id, taskId)));
      }),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Create one task. `due` is YYYY-MM-DD and renders as an all-day item on Google Calendar. For several tasks at once use create_tasks.",
      inputSchema: z.object({
        list: listRefSchema,
        title: titleSchema,
        notes: notesSchema.optional(),
        due: dateSchema.optional(),
        parentTaskId: z
          .string()
          .optional()
          .describe("Make this a subtask of the given task (one level only)"),
        afterTaskId: z
          .string()
          .optional()
          .describe("Place this task right after the given sibling task"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ list, title, notes, due, parentTaskId, afterTaskId }) =>
      runTool(async () => {
        const { id } = await client.resolveList(list);
        const body: TaskInput = { title };
        if (notes) body.notes = notes;
        if (due) body.due = toApiDate(due);
        const task = await client.insertTask(id, body, {
          parent: parentTaskId,
          previous: afterTaskId,
        });
        return jsonResult(toView(task));
      }),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Change a task's title, notes, due date, or status. Pass due=null or notes=null to clear that field. Only the fields you pass are changed.",
      inputSchema: z.object({
        list: listRefSchema,
        taskId: taskIdSchema,
        title: titleSchema.optional(),
        notes: notesSchema.nullable().optional(),
        due: dateSchema.nullable().optional(),
        status: z.enum(["needsAction", "completed"]).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ list, taskId, title, notes, due, status }) =>
      runTool(async () => {
        const { id } = await client.resolveList(list);
        const task = await applyPatch(client, id, taskId, { title, notes, due, status });
        return jsonResult(toView(task));
      }),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description: "Mark a task as completed.",
      inputSchema: z.object({ list: listRefSchema, taskId: taskIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ list, taskId }) =>
      runTool(async () => {
        const { id } = await client.resolveList(list);
        const task = await client.patchTask(id, taskId, { status: "completed" });
        return jsonResult(toView(task));
      }),
  );

  server.registerTool(
    "reopen_task",
    {
      title: "Reopen task",
      description: "Mark a completed task as not done again.",
      inputSchema: z.object({ list: listRefSchema, taskId: taskIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ list, taskId }) =>
      runTool(async () => {
        const { id } = await client.resolveList(list);
        const task = await applyPatch(client, id, taskId, { status: "needsAction" });
        return jsonResult(toView(task));
      }),
  );

  server.registerTool(
    "move_task",
    {
      title: "Move task",
      description:
        "Reorder a task, nest it under a parent, un-nest it, or move it to another list. Omit parentTaskId to move to top level. Recurring tasks cannot be moved between lists.",
      inputSchema: z.object({
        list: listRefSchema,
        taskId: taskIdSchema,
        parentTaskId: z.string().optional().describe("New parent task id (omit for top level)"),
        afterTaskId: z.string().optional().describe("Sibling task to place this one after (omit for first position)"),
        toList: z.string().optional().describe("Destination list id or title, to move across lists"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ list, taskId, parentTaskId, afterTaskId, toList }) =>
      runTool(async () => {
        const { id } = await client.resolveList(list);
        const dest = toList ? (await client.resolveList(toList)).id : undefined;
        const task = await client.moveTask(id, taskId, {
          parent: parentTaskId,
          previous: afterTaskId,
          destinationTasklist: dest,
        });
        return jsonResult(toView(task));
      }),
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete task",
      description: "Permanently delete a task (and its subtasks). Irreversible.",
      inputSchema: z.object({ list: listRefSchema, taskId: taskIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ list, taskId }) =>
      runTool(async () => {
        const { id } = await client.resolveList(list);
        await client.deleteTask(id, taskId);
        return textResult(`Deleted task ${taskId}.`);
      }),
  );

  server.registerTool(
    "clear_completed",
    {
      title: "Clear completed tasks",
      description:
        "Hide all completed tasks in a list (same as 'Clear completed' in the Google Tasks UI). They stay retrievable with list_tasks status=completed but disappear from the default view. Not reversible via the API.",
      inputSchema: z.object({ list: listRefSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ list }) =>
      runTool(async () => {
        const { id, title } = await client.resolveList(list);
        await client.clearCompleted(id);
        return textResult(`Cleared completed tasks in "${title}".`);
      }),
  );
}

interface PatchArgs {
  title?: string | undefined;
  notes?: string | null | undefined;
  due?: string | null | undefined;
  status?: Task["status"] | undefined;
}

/**
 * PATCH the changed fields. Google's JSON PATCH clears a field when it is
 * sent as null; if that doesn't take (observed on some fields), fall back to
 * a full PUT with the field omitted.
 */
async function applyPatch(
  client: TasksClient,
  listId: string,
  taskId: string,
  args: PatchArgs,
): Promise<Task> {
  const body: TaskInput = {};
  if (args.title !== undefined) body.title = args.title;
  if (args.notes !== undefined) body.notes = args.notes;
  if (args.due !== undefined) body.due = args.due === null ? null : toApiDate(args.due);
  if (args.status !== undefined) {
    body.status = args.status;
    if (args.status === "needsAction") body.completed = null;
  }
  if (Object.keys(body).length === 0) {
    throw new Error("Nothing to update — pass at least one of title, notes, due, status.");
  }

  let task = await client.patchTask(listId, taskId, body);

  const wantsDueCleared = args.due === null && task.due !== undefined;
  const wantsNotesCleared = args.notes === null && task.notes !== undefined;
  const wantsCompletedCleared =
    args.status === "needsAction" && task.completed !== undefined;
  if (wantsDueCleared || wantsNotesCleared || wantsCompletedCleared) {
    const full = await client.getTask(listId, taskId);
    const replacement: Task = { ...full };
    if (wantsDueCleared) delete replacement.due;
    if (wantsNotesCleared) delete replacement.notes;
    if (wantsCompletedCleared) delete replacement.completed;
    task = await client.updateTask(listId, taskId, replacement);
  }
  return task;
}
