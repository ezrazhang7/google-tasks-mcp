import { z } from "zod";
import type { Task } from "../google/types.js";
import { fromApiDate } from "../utils/dates.js";

export const listRefSchema = z
  .string()
  .optional()
  .describe(
    'Task list id or title (case-insensitive). Omit or pass "@default" for the account\'s default list. Call list_tasklists to see what exists.',
  );

export const taskIdSchema = z.string().describe("Task id (from list_tasks / create_task)");

export const dateSchema = z
  .string()
  .describe(
    "Date in YYYY-MM-DD form. Google Tasks stores DATES ONLY (no time of day); the task appears as all-day on that date in Google Calendar.",
  );

export const titleSchema = z
  .string()
  .min(1)
  .max(1024)
  .describe("Task title — this is the text shown on the calendar (max 1024 chars)");

export const notesSchema = z
  .string()
  .max(8192)
  .describe("Task notes / description (max 8192 chars)");

/** Compact, token-friendly view of a task for tool output. */
export interface TaskView {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status: Task["status"];
  completed?: string;
  parent?: string;
  webViewLink?: string;
  hidden?: boolean;
  deleted?: boolean;
}

export function toView(task: Task): TaskView {
  const view: TaskView = { id: task.id, title: task.title, status: task.status };
  if (task.notes) view.notes = task.notes;
  const due = fromApiDate(task.due);
  if (due) view.due = due;
  if (task.completed) view.completed = task.completed;
  if (task.parent) view.parent = task.parent;
  if (task.webViewLink) view.webViewLink = task.webViewLink;
  if (task.hidden) view.hidden = true;
  if (task.deleted) view.deleted = true;
  return view;
}
